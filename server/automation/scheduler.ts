/**
 * Time based work, driven by an injected clock: date and schedule rules (through the same engine the
 * browser uses) and the delivery of queued e-mail (immediate rows and digests). One instance serves
 * the whole process; `tick()` is safe to call as often as you like and from several instances, because
 * every time based run is claimed in the run log (unique dedup key) before it acts.
 */
import { batchDigests, type PendingEmail } from '../../src/automation/digest'
import { evaluateTick, type EngineContext } from '../../src/automation/engine'
import { executeRun, type ExecBackend } from '../../src/automation/execute'
import { createRunGuard, type RunGuard } from '../../src/automation/guard'
import { validateCell } from '../../src/model/validate'
import type { Logger } from '../log'
import type { AutomationConfig } from './config'
import type { Outbound } from './outbound'
import type { RequestService } from './requests'
import type { AutomationStore, OwnerInfo, RuleRow, SheetBundle } from './store'
import { formatValue } from '../../src/automation/values'

const DAY_MS = 86_400_000

export interface Scheduler {
  /** Runs due date / schedule rules, then delivers due e-mail. */
  tick(): Promise<{ runs: number; emails: number }>
  start(): void
  stop(): void
}

export interface SchedulerDeps {
  store: AutomationStore
  outbound: Outbound
  requests: RequestService
  config: Pick<AutomationConfig, 'tickMs' | 'publicUrl'>
  now: () => number
  log: Logger
  guard?: RunGuard
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { store, outbound, requests, config, now, log } = deps
  const guard = deps.guard ?? createRunGuard({ now, perRulePerMinute: 200, totalPerMinute: 1000 })
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  function backendFor(bundle: SheetBundle, owner: { id: string; workspaceId: string }): ExecBackend {
    return {
      sheetId: bundle.id,
      sheetName: bundle.name,
      now,
      createNotifications: (rows) => store.createNotifications(owner.id, rows),
      async setCell(rowId, columnId, value) {
        const col = bundle.columns.find((c) => c.id === columnId)
        if (!col) return { ok: false, error: 'The column no longer exists.' }
        const res = validateCell(col, typeof value === 'string' ? value : formatValue(value), { rowCount: 1, ownRowNumber: 1, hoursPerDay: bundle.hoursPerDay, dependenciesEnabled: false })
        if (!res.ok) return { ok: false, error: res.error }
        return store.patchCells(rowId, { [columnId]: res.value })
      },
      async setLock(rowId, locked, ruleId) {
        await store.setLock(bundle.id, rowId, owner, locked, ruleId)
        return { ok: true }
      },
      async moveCopy(kind, rowId, targetSheetId) {
        await store.copyRow(rowId, targetSheetId, kind === 'move')
        return { ok: true }
      },
      async sendUpdateRequest(a, rule) {
        const r = await requests.create(bundle, { kind: 'update', ruleId: rule.id, rowId: a.rowId, emails: a.emails, message: a.message, expiresInDays: a.expiresInDays, columnIds: a.columnIds })
        return r.ok ? { ok: true } : { ok: false, error: r.error }
      },
      async sendApproval(a, rule) {
        const r = await requests.create(bundle, {
          kind: 'approval',
          ruleId: rule.id,
          rowId: a.rowId,
          emails: a.emails,
          message: a.message,
          expiresInDays: a.expiresInDays,
          approval: { statusColumnId: a.statusColumnId, pendingValue: a.pendingValue, approvedValue: a.approvedValue, declinedValue: a.declinedValue, showColumnIds: a.showColumnIds },
        })
        return r.ok ? { ok: true } : { ok: false, error: r.error }
      },
      recordRun: (r) => store.recordRun(owner, r),
    }
  }

  async function runRules(): Promise<number> {
    const rules = await store.timeRules()
    if (rules.length === 0) return 0
    const bySheet = new Map<string, RuleRow[]>()
    for (const r of rules) bySheet.set(r.sheetId, [...(bySheet.get(r.sheetId) ?? []), r])
    const fired = await store.firedKeys(now() - 2 * DAY_MS)
    let count = 0
    for (const [sheetId, sheetRules] of bySheet) {
      try {
        const bundle = await store.sheet(sheetId)
        if (!bundle) continue
        const ownerInfo = await store.owner(bundle.ownerId)
        const locked = await store.lockedRows(sheetId)
        const ctx: EngineContext = {
          sheetId,
          sheetName: bundle.name,
          columns: bundle.columns,
          now: now(),
          tzOffsetMinutes: 0,
          ownerEmail: ownerInfo?.email ?? null,
          lockedRowIds: locked,
        }
        const lastRunAt: Record<string, number> = {}
        for (const r of sheetRules) if (r.lastRunAt) lastRunAt[r.id] = Date.parse(r.lastRunAt)
        const res = evaluateTick(sheetRules, bundle.rows.map((r) => ({ id: r.id, cells: r.cells })), ctx, { lastRunAt, fired }, guard)
        const backend = backendFor(bundle, { id: bundle.ownerId, workspaceId: bundle.workspaceId })
        for (const s of res.skipped) {
          await backend.recordRun({ ruleId: s.ruleId, ruleName: s.ruleName, sheetId, rowId: s.rowId, source: 'server', outcome: 'skipped', detail: { reason: s.reason }, dedupKey: null }).catch(() => {})
        }
        for (const run of res.runs) {
          const rule = sheetRules.find((r) => r.id === run.ruleId)!
          const out = await executeRun(run, rule, backend, 'server')
          if (run.dedupKey) fired.add(run.dedupKey)
          if (out.claimed) {
            count++
            await store.touchRule(rule.id, now())
          }
        }
      } catch (err) {
        log('automation.rules.failed', { sheetId, error: (err as Error).message })
      }
    }
    return count
  }

  async function deliverEmails(): Promise<number> {
    const t = now()
    const pending = await store.pendingEmails(t, 500)
    if (pending.length === 0) return 0
    const meta = new Map(pending.map((p) => [p.id, p]))
    const link = (id: string) => {
      const p = meta.get(id)
      return config.publicUrl && p?.sheetId ? `${config.publicUrl}/?sheet=${p.sheetId}${p.rowId ? `&row=${p.rowId}` : ''}` : null
    }
    const items: PendingEmail[] = pending.map((p) => ({ id: p.id, ownerId: p.ownerId, recipientEmail: p.recipientEmail, frequency: p.frequency, subject: p.title, body: p.body, link: link(p.id), deliverAfter: p.deliverAfter }))
    const owners = new Map<string, OwnerInfo | null>()
    let sent = 0
    for (const out of batchDigests(items, t)) {
      if (!owners.has(out.ownerId)) owners.set(out.ownerId, await store.owner(out.ownerId))
      const first = meta.get(out.ids[0])
      const res = await outbound.send(owners.get(out.ownerId) ?? null, out.ownerId, { to: out.recipientEmail, subject: out.subject, text: out.text }, { sheetId: first?.sheetId ?? null, rowId: out.ids.length === 1 ? (first?.rowId ?? null) : null, ruleId: null })
      await store.markEmails(out.ids, res.status, res.error, now())
      if (res.status === 'sent' || res.status === 'simulated') sent++
    }
    return sent
  }

  async function tick() {
    if (running) return { runs: 0, emails: 0 } // a slow tick is not overlapped by the next
    running = true
    try {
      const runs = await runRules().catch((err) => {
        log('automation.tick.failed', { error: (err as Error).message })
        return 0
      })
      const emails = await deliverEmails().catch((err) => {
        log('automation.email.failed', { error: (err as Error).message })
        return 0
      })
      if (runs > 0 || emails > 0) log('automation.tick', { runs, emails })
      return { runs, emails }
    } finally {
      running = false
    }
  }

  return {
    tick,
    start() {
      if (timer) return
      timer = setInterval(() => void tick(), config.tickMs)
      timer.unref()
      setTimeout(() => void tick(), 5_000).unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
