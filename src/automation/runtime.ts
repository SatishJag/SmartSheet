/**
 * Runs the signed-in user's row-change rules in the browser. It watches the open sheet's store,
 * turns what changed into engine events, asks the engine what to do and carries it out (in-app
 * notifications, e-mail outbox rows, record a date, lock / unlock, move / copy, requests through the
 * server) and logs every run.
 *
 * It never slows editing: the store subscription only schedules a flush (setTimeout 0), the diff runs
 * once per burst of changes (a paste of 500 cells is one flush) and nothing at all happens while the
 * sheet has no enabled row-change rule. Everything here is wrapped so that a failure (for example the
 * 0009 migration is not applied yet) disables automation for the sheet instead of breaking editing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { StoreApi } from 'zustand/vanilla'
import type { SheetState } from '../store/sheetStore'
import { emitNotificationsChanged } from './bus'
import { automationApi, type AutomationApi } from './db'
import { changedColumns, evaluateRowEvent, rowLabel, type EngineContext } from './engine'
import { executeRun, type ExecBackend, type StepResult } from './execute'
import { createRunGuard, type RunGuard } from './guard'
import { clearLocks, lockedRowIds, setLockedRows, setRowLocked } from './locks'
import { requestBodyFor, sendRequest, type RequestBody } from './serverApi'
import type { AutomationRule, RowSnapshot, SheetEvent } from './types'
import { formatValue } from './values'

export interface RuntimeDeps {
  client: SupabaseClient
  store: StoreApi<SheetState>
  api?: AutomationApi
  now?: () => number
  tzOffsetMinutes?: () => number
  sendRequest?: (body: RequestBody) => Promise<StepResult>
  guard?: RunGuard
  log?: (message: string, err?: unknown) => void
}

export interface AutomationRuntime {
  start(): void
  stop(): void
  /** Resolves when every scheduled flush and its actions have finished (for tests). */
  idle(): Promise<void>
}

const ROW_TRIGGERS = new Set(['row_added', 'row_changed', 'cell_becomes'])

export function createAutomationRuntime(deps: RuntimeDeps): AutomationRuntime {
  const { store } = deps
  const api = deps.api ?? automationApi(deps.client)
  const now = deps.now ?? Date.now
  const tz = deps.tzOffsetMinutes ?? (() => -new Date().getTimezoneOffset())
  const guard = deps.guard ?? createRunGuard({ now })
  const log = deps.log ?? ((m: string, e?: unknown) => console.warn(`[automation] ${m}`, e))
  const send = deps.sendRequest ?? ((body: RequestBody) => sendRequest(deps.client, body))

  let rules: AutomationRule[] = []
  let loadedFor: string | null = null
  let snapshot = new Map<string, Record<string, unknown>>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let queue: Promise<void> = Promise.resolve()
  let unsubscribe: (() => void) | null = null
  let stopped = false
  let loading: Promise<void> = Promise.resolve()
  /** Cells that rule actions wrote, so the change they cause is attributed to the rule (loop protection). */
  const origins = new Map<string, { cols: Set<string>; chain: string[] }>()

  const hasRowRules = () => rules.some((r) => r.enabled && ROW_TRIGGERS.has(r.trigger.type))

  const snapshotOf = (rows: readonly { id: string; cells: Record<string, unknown> }[]) => new Map(rows.map((r) => [r.id, r.cells]))

  async function load(sheetId: string): Promise<void> {
    loadedFor = sheetId
    try {
      const [loaded, locked] = await Promise.all([api.listRules(sheetId), api.listLocks(sheetId)])
      if (stopped) return
      rules = loaded
      setLockedRows(sheetId, locked)
      snapshot = snapshotOf(store.getState().data?.rows ?? [])
    } catch (err) {
      rules = [] // automation is simply off for this sheet
      log('could not load rules (is migration 0009 applied?)', err)
    }
  }

  function onStoreChange(): void {
    if (stopped) return
    const data = store.getState().data
    if (!data) return
    if (loadedFor !== data.sheet.id) {
      loading = load(data.sheet.id)
      return
    }
    if (!hasRowRules()) return
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      queue = queue.then(flush).catch((err) => log('run failed', err))
    }, 0)
  }

  function diff(): SheetEvent[] {
    const data = store.getState().data
    if (!data) return []
    const events: SheetEvent[] = []
    const next = snapshotOf(data.rows)
    for (const row of data.rows) {
      const before = snapshot.get(row.id)
      if (before === undefined) {
        events.push({ kind: 'row_added', row: { id: row.id, cells: row.cells } })
      } else if (before !== row.cells) {
        const changed = changedColumns(before, row.cells, data.columns)
        if (changed.length === 0) continue
        const o = origins.get(row.id)
        const origin = o && changed.every((c) => o.cols.has(c)) ? o.chain : undefined
        events.push({ kind: 'row_changed', before: { id: row.id, cells: before }, after: { id: row.id, cells: row.cells }, ...(origin ? { origin } : {}) })
      }
    }
    snapshot = next
    origins.clear()
    return events
  }

  function backendFor(sheetId: string, sheetName: string, chain: string[]): ExecBackend {
    return {
      sheetId,
      sheetName,
      now,
      async createNotifications(rows) {
        await api.createNotifications(rows)
        if (rows.some((r) => r.channel === 'app')) emitNotificationsChanged()
      },
      async setCell(rowId, columnId, value) {
        origins.set(rowId, { cols: new Set([columnId]), chain })
        const res = store.getState().setCell(rowId, columnId, typeof value === 'string' ? value : formatValue(value))
        return res.ok ? { ok: true } : { ok: false, error: res.error }
      },
      async setLock(rowId, locked, ruleId) {
        if (locked) await api.lockRow(sheetId, rowId, ruleId)
        else await api.unlockRow(rowId)
        setRowLocked(sheetId, rowId, locked)
        return { ok: true }
      },
      async moveCopy(kind, rowId, targetSheetId) {
        await api.copyRow(rowId, targetSheetId)
        if (kind === 'move') store.getState().deleteRow(rowId)
        return { ok: true }
      },
      sendUpdateRequest: (a, rule) => send(requestBodyFor(a, rule.id, sheetId)),
      sendApproval: (a, rule) => send(requestBodyFor(a, rule.id, sheetId)),
      recordRun: (r) => api.insertRun(r),
    }
  }

  async function flush(): Promise<void> {
    const data = store.getState().data
    if (!data || stopped || loadedFor !== data.sheet.id) return
    const events = diff()
    if (events.length === 0) return
    const ctx: EngineContext = {
      sheetId: data.sheet.id,
      sheetName: data.sheet.name,
      columns: data.columns,
      now: now(),
      tzOffsetMinutes: tz(),
      lockedRowIds: lockedRowIds(data.sheet.id),
    }
    for (const ev of events) {
      const { runs, skipped } = evaluateRowEvent(rules, ev, { ...ctx, now: now() }, guard)
      const row: RowSnapshot = ev.kind === 'row_added' ? ev.row : ev.after
      for (const s of skipped) {
        await api
          .insertRun({ ruleId: s.ruleId, ruleName: s.ruleName, sheetId: ctx.sheetId, rowId: s.rowId, source: 'browser', outcome: 'skipped', detail: { reason: s.reason, row: rowLabel(row.cells, ctx) }, dedupKey: null })
          .catch((err) => log('could not log a skipped run', err))
      }
      for (const run of runs) {
        const rule = rules.find((r) => r.id === run.ruleId)
        if (!rule) continue
        const chain = [...(ev.origin ?? []), rule.id]
        await executeRun(run, rule, backendFor(ctx.sheetId, ctx.sheetName, chain), 'browser')
        void api.touchRule(rule.id, new Date(now())).catch(() => {})
      }
    }
  }

  return {
    start() {
      stopped = false
      unsubscribe = store.subscribe(onStoreChange)
      onStoreChange()
    },
    stop() {
      stopped = true
      unsubscribe?.()
      unsubscribe = null
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (loadedFor) clearLocks(loadedFor)
      loadedFor = null
    },
    async idle() {
      // wait for the load, let a scheduled flush start, then wait for the queue to drain
      await loading
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 0))
        await queue
        if (timer === null) break
      }
    },
  }
}
