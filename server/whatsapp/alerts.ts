/**
 * Proactive messages, per WhatsApp-enabled sheet (the owner turned it on in the planner):
 *
 *   delay alerts     a task is past its finish and not complete: its owners get it once per finish
 *                    date and can answer 1-4; a critical task without a reachable owner goes to the
 *                    sheet owner instead
 *   progress checks  at 50 / 70 / 90 % of a task's planned time, when reported progress is behind,
 *                    the task's owners are asked how it is going; reminders every `reminderHours` up
 *                    to `maxReminders`, then the sheet owner is told nobody answered
 *   daily summary    to the sheet owner, once a day from `summaryHour` (sheet time zone)
 *
 * And the "Also send on WhatsApp" option of Automation rules: their `notifications` rows with channel
 * `whatsapp` are resolved to phones here.
 *
 * Every message has a dedup key, so running this from several instances or more often is harmless.
 */
import { WHATSAPP_OWNER_RECIPIENT } from '../../src/automation/types'
import { delayAlertMessage, noResponseMessage, nudgeMessage, summaryMessage } from '../../src/whatsapp/format'
import { delayed, menuCounts } from '../../src/whatsapp/select'
import { daysBetween, localTime } from '../../src/whatsapp/time'
import type { Logger } from '../log'
import type { Conversation, LoadedSheet } from './conversation'
import { queue, resolveRecipients } from './outbox'
import type { NudgeRow, SheetSettings, WhatsAppStore } from './store'

const HOUR_MS = 3_600_000
const MILESTONES = [90, 70, 50] as const
/** Alerts per phone per sheet per run: the first run on an old schedule must not flood anyone. */
const PER_PHONE_PER_RUN = 5

export interface AlertDeps {
  store: WhatsAppStore
  conversation: Conversation
  now: () => number
  log: Logger
  alertEveryMs: number
}

export function createAlerts(deps: AlertDeps) {
  const { store, conversation, now, log } = deps
  const lastRun = new Map<string, number>()

  async function ownerPhone(ownerId: string): Promise<string | null> {
    const link = await store.linkByUser(ownerId)
    if (!link || (await store.isOptedOut(link.phone))) return null
    return link.phone
  }

  async function delayAlerts(s: LoadedSheet, st: SheetSettings, owner: string | null) {
    const perPhone = new Map<string, number>()
    let sent = 0
    for (const t of delayed(s.facts.work)) {
      const recipients = await resolveRecipients(store, s.meta.ownerId, t.owners)
      const targets = recipients.map((r) => ({ phone: r.phone, toOwner: true }))
      if (targets.length === 0 && t.critical && owner) targets.push({ phone: owner, toOwner: false })
      for (const target of targets) {
        const n = perPhone.get(target.phone) ?? 0
        if (n >= PER_PHONE_PER_RUN) continue
        const ok = await queue(
          store,
          {
            ownerId: s.meta.ownerId,
            phone: target.phone,
            body: delayAlertMessage(t, s.meta.name, { toOwner: target.toOwner || target.phone === owner }),
            kind: 'alert',
            priority: t.critical ? 'HIGH' : 'MEDIUM',
            sheetId: s.meta.id,
            rowId: t.rowId,
            dedupKey: `delay:${t.rowId}:${t.finish}:${target.phone}`,
          },
          now(),
          st,
        )
        if (!ok) continue
        perPhone.set(target.phone, n + 1)
        sent++
        await conversation.setPending(target.phone, { sheetId: s.meta.id, rowId: t.rowId, ownerId: s.meta.ownerId, kind: 'alert', at: now() })
      }
    }
    return sent
  }

  async function progressChecks(s: LoadedSheet, st: SheetSettings, owner: string | null) {
    const existing = new Map<string, NudgeRow>()
    for (const n of await store.nudges(s.meta.id)) existing.set(`${n.rowId}|${n.milestone}|${n.phone}`, n)
    const t0 = now()
    let sent = 0
    for (const t of s.facts.work) {
      if (t.complete || t.milestone || !t.start || !t.finish || t.owners.length === 0) continue
      const span = daysBetween(t.start, t.finish)
      const elapsed = daysBetween(t.start, s.today)
      if (span <= 0 || elapsed < 0 || s.today > t.finish) continue
      const pct = (elapsed / span) * 100
      const milestone = MILESTONES.find((m) => pct >= m)
      if (!milestone || (t.percent !== null && t.percent >= milestone)) continue
      for (const r of await resolveRecipients(store, s.meta.ownerId, t.owners)) {
        const key = `${t.rowId}|${milestone}|${r.phone}`
        const prev = existing.get(key)
        const base = { rowId: t.rowId, milestone, phone: r.phone, sheetId: s.meta.id, ownerId: s.meta.ownerId }
        if (!prev) {
          const ok = await queue(store, { ownerId: s.meta.ownerId, phone: r.phone, body: nudgeMessage(t, s.meta.name, milestone, 0), kind: 'nudge', priority: 'MEDIUM', sheetId: s.meta.id, rowId: t.rowId, dedupKey: `nudge:${t.rowId}:${milestone}:${r.phone}:0` }, t0, st)
          if (ok) {
            sent++
            await store.saveNudge({ ...base, sentCount: 1, lastSentAt: t0, answeredAt: null, noResponseAt: null })
            await conversation.setPending(r.phone, { sheetId: s.meta.id, rowId: t.rowId, ownerId: s.meta.ownerId, kind: 'nudge', at: t0 })
          }
          continue
        }
        if (prev.answeredAt !== null || prev.noResponseAt !== null || t0 - prev.lastSentAt < st.reminderHours * HOUR_MS) continue
        const reminder = prev.sentCount
        if (reminder <= st.maxReminders) {
          const ok = await queue(store, { ownerId: s.meta.ownerId, phone: r.phone, body: nudgeMessage(t, s.meta.name, milestone, reminder), kind: 'nudge', priority: 'MEDIUM', sheetId: s.meta.id, rowId: t.rowId, dedupKey: `nudge:${t.rowId}:${milestone}:${r.phone}:${reminder}` }, t0, st)
          await store.saveNudge({ ...prev, sentCount: prev.sentCount + 1, lastSentAt: t0 })
          if (ok) {
            sent++
            await conversation.setPending(r.phone, { sheetId: s.meta.id, rowId: t.rowId, ownerId: s.meta.ownerId, kind: 'nudge', at: t0 })
          }
        } else {
          await store.saveNudge({ ...prev, noResponseAt: t0 })
          const body = noResponseMessage(t, s.meta.name, r.label, milestone, prev.sentCount)
          await store.notifyInApp(s.meta.ownerId, { sheetId: s.meta.id, rowId: t.rowId, title: `No answer from ${r.label} about “${t.name}”`, body })
          if (owner && owner !== r.phone) {
            await queue(store, { ownerId: s.meta.ownerId, phone: owner, body, kind: 'alert', priority: 'MEDIUM', sheetId: s.meta.id, rowId: t.rowId, dedupKey: `noresp:${t.rowId}:${milestone}:${r.phone}` }, t0, st)
          }
        }
      }
    }
    return sent
  }

  async function dailySummary(s: LoadedSheet, st: SheetSettings, owner: string | null, force = false) {
    if (!owner) return false
    const lt = localTime(now(), st.timeZone)
    if (!force && (!st.dailySummary || lt.hour < st.summaryHour)) return false
    const w = s.facts.work
    return queue(
      store,
      { ownerId: s.meta.ownerId, phone: owner, body: summaryMessage(s.meta.name, s.today, menuCounts(w), delayed(w)), kind: 'summary', priority: force ? 'HIGH' : 'MEDIUM', sheetId: s.meta.id, dedupKey: force ? null : `summary:${s.meta.id}:${lt.date}` },
      now(),
      st,
    )
  }

  /** Runs the alerts of one sheet now. */
  async function runSheet(st: SheetSettings): Promise<{ alerts: number; nudges: number; summary: boolean }> {
    lastRun.set(st.sheetId, now())
    const s = await conversation.load(st.sheetId)
    if (!s || s.meta.ownerId !== st.ownerId) return { alerts: 0, nudges: 0, summary: false }
    const owner = await ownerPhone(s.meta.ownerId)
    const alerts = st.delayAlerts ? await delayAlerts(s, st, owner) : 0
    const nudges = st.nudges ? await progressChecks(s, st, owner) : 0
    const summary = await dailySummary(s, st, owner)
    return { alerts, nudges, summary }
  }

  async function run(): Promise<number> {
    let count = 0
    for (const st of await store.enabledSettings()) {
      if (now() - (lastRun.get(st.sheetId) ?? 0) < deps.alertEveryMs) continue
      try {
        const r = await runSheet(st)
        count += r.alerts + r.nudges + (r.summary ? 1 : 0)
      } catch (err) {
        log('whatsapp.alerts.failed', { sheetId: st.sheetId, error: (err as Error).message })
      }
    }
    return count
  }

  /** "Send me the summary now" from the planner. False when the owner has no linked phone. */
  async function summaryNow(sheetId: string): Promise<boolean> {
    const s = await conversation.load(sheetId)
    if (!s) return false
    const st = (await store.settings(sheetId)) ?? null
    const owner = await ownerPhone(s.meta.ownerId)
    if (!owner) return false
    return dailySummary(s, st ?? { sheetId, ownerId: s.meta.ownerId, enabled: true, delayAlerts: false, nudges: false, reminderHours: 24, maxReminders: 0, dailySummary: true, summaryHour: 0, timeZone: 'UTC', dndStart: '00:00', dndEnd: '00:00', ownerColumnId: null }, owner, true)
  }

  /** Automation rules with "Also send on WhatsApp". */
  async function ruleMessages(): Promise<number> {
    const pending = await store.pendingRuleMessages(now(), 200)
    let sent = 0
    const ownerEmails = new Map<string, string | null>()
    for (const m of pending) {
      try {
        if (!ownerEmails.has(m.ownerId)) ownerEmails.set(m.ownerId, (await store.account(m.ownerId))?.email ?? null)
        const phones: string[] = []
        if (m.email === WHATSAPP_OWNER_RECIPIENT || ownerEmails.get(m.ownerId) === m.email.toLowerCase()) {
          const p = await ownerPhone(m.ownerId)
          if (p) phones.push(p)
        } else phones.push(...(await resolveRecipients(store, m.ownerId, [m.email])).map((r) => r.phone))
        if (phones.length === 0) {
          await store.markRuleMessage(m.id, 'skipped', `${m.email} has no WhatsApp number linked or joined.`, now())
          continue
        }
        const st = m.sheetId ? await store.settings(m.sheetId) : null
        for (const phone of phones) {
          await queue(store, { ownerId: m.ownerId, phone, body: `*${m.title}*\n\n${m.body}`.trim(), kind: 'rule', priority: 'MEDIUM', sheetId: m.sheetId, rowId: m.rowId, dedupKey: `rule:${m.id}:${phone}` }, now(), st)
        }
        await store.markRuleMessage(m.id, 'sent', null, now())
        sent++
      } catch (err) {
        log('whatsapp.rule.failed', { id: m.id, error: (err as Error).message })
        await store.markRuleMessage(m.id, 'failed', (err as Error).message, now()).catch(() => {})
      }
    }
    return sent
  }

  return { run, runSheet, summaryNow, ruleMessages }
}

export type Alerts = ReturnType<typeof createAlerts>
