/**
 * The rule engine. PURE: it never reads a clock, a database or the network. Callers pass the
 * rules, an event (a row was added / changed) or a time tick, and the clock (`ctx.now`); the engine
 * returns what to do (`PlannedRun`s). Executors (browser runtime, server scheduler, test run) carry
 * the actions out.
 *
 * Guarantees
 * - A rule runs at most once per event (and per row): an action's own write comes back as a new
 *   event carrying `origin` (the rules that caused it), and a rule in `origin` is never run again
 *   by it (`skipped: loop`); chains stop at MAX_CHAIN_DEPTH (`depth`).
 * - A RunGuard caps runs per rule and in total per minute (`throttled`).
 * - Time based runs carry a `dedupKey`; recorded once per key they never repeat.
 */
import type { Column } from '../model/validate'
import { evaluateGroup, explainGroup, type CondEnv, type ConditionOutcome } from './conditions'
import { describeCondition } from './describe'
import type { RunGuard } from './guard'
import { dateTriggerTarget, isIsoDate, latestOccurrence, nextDigestTime, todayIso } from './time'
import type {
  Action,
  AutomationRule,
  EvalResult,
  NotifyAction,
  NotifyItem,
  PlannedAction,
  PlannedRun,
  Recipient,
  RowSnapshot,
  SheetEvent,
  SkippedRun,
  Trigger,
} from './types'
import { emailsIn, formatValue, isBlank, looseEquals, type Cells } from './values'

export const MAX_CHAIN_DEPTH = 5

export interface EngineContext {
  sheetId: string
  sheetName: string
  columns: readonly Column[]
  /** The clock, ms since epoch. */
  now: number
  /** Minutes east of UTC for "today" and the daily digest hour; default 0. */
  tzOffsetMinutes?: number
  /** Used to put the owner's address on e-mail recipients; unknown for anonymous visitors. */
  ownerEmail?: string | null
  /** The column that names a row (default: the first text column). */
  primaryColumnId?: string
  /** Rows locked right now; actions that would write to them are skipped. */
  lockedRowIds?: ReadonlySet<string>
}

/** What a time tick needs to know about earlier runs. */
export interface TickState {
  /** ms of the last recorded run of each rule (falls back to the rule's creation time). */
  lastRunAt: Readonly<Record<string, number>>
  /** `dedupKey`s already recorded. */
  fired: ReadonlySet<string>
}

// ---- helpers ----

export function rowLabel(cells: Cells, ctx: Pick<EngineContext, 'columns' | 'primaryColumnId'>): string {
  const col =
    ctx.columns.find((c) => c.id === ctx.primaryColumnId) ?? ctx.columns.find((c) => c.type === 'TEXT_NUMBER' && !c.role) ?? ctx.columns[0]
  const v = col ? formatValue(cells[col.id]).trim() : ''
  return v === '' ? '(untitled row)' : v
}

/** Columns whose value differs between two versions of a row. */
export function changedColumns(before: Cells, after: Cells, columns: readonly Column[]): string[] {
  return columns.filter((c) => !looseEquals(before[c.id], after[c.id], c)).map((c) => c.id)
}

function triggerMatchesEvent(t: Trigger, event: SheetEvent, changed: readonly string[], columns: readonly Column[]): boolean {
  switch (t.type) {
    case 'row_added':
      return event.kind === 'row_added'
    case 'row_changed':
      if (event.kind !== 'row_changed' || changed.length === 0) return false
      return !t.columnIds || t.columnIds.length === 0 || t.columnIds.some((id) => changed.includes(id))
    case 'cell_becomes': {
      if (!changed.includes(t.columnId)) return false
      const after = event.kind === 'row_added' ? event.row.cells : event.after.cells
      const col = columns.find((c) => c.id === t.columnId)
      return looseEquals(after[t.columnId], t.value, col)
    }
    default:
      return false // date and schedule triggers run on ticks
  }
}

/** `{{Column title}}` -> the row's value (blank when unknown). */
export function renderTemplate(text: string, cells: Cells, ctx: Pick<EngineContext, 'columns' | 'sheetName'>): string {
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, name: string) => {
    if (name.toLowerCase() === 'sheet') return ctx.sheetName
    const col = ctx.columns.find((c) => c.title.toLowerCase() === name.toLowerCase())
    return col ? formatValue(cells[col.id]) : ''
  })
}

function resolveRecipients(rs: readonly Recipient[], cells: Cells): { inApp: boolean; emails: string[] } {
  let inApp = false
  const emails: string[] = []
  const add = (e: string) => {
    const l = e.trim().toLowerCase()
    if (l && !emails.includes(l)) emails.push(l)
  }
  for (const r of rs) {
    if (r.kind === 'owner') inApp = true
    else if (r.kind === 'email') for (const e of emailsIn(r.email)) add(e)
    else for (const e of emailsIn(cells[r.columnId])) add(e)
  }
  return { inApp, emails }
}

function notifyItem(a: NotifyAction, row: RowSnapshot, ctx: EngineContext): NotifyItem {
  const cols =
    a.include === 'none'
      ? []
      : a.include === 'columns'
        ? (a.columnIds ?? []).flatMap((id) => ctx.columns.filter((c) => c.id === id))
        : ctx.columns
  const values = cols
    .filter((c) => !isBlank(row.cells[c.id], c))
    .map((c) => ({ title: c.title, value: formatValue(row.cells[c.id]) }))
  return { rowId: row.id, label: rowLabel(row.cells, ctx), values }
}

/** The actions one action definition produces for one or more matching rows. */
function planAction(rule: AutomationRule, rows: readonly RowSnapshot[], ctx: EngineContext, notes: string[]): PlannedAction[] {
  const a: Action = rule.action
  const today = todayIso(ctx.now, ctx.tzOffsetMinutes)
  switch (a.type) {
    case 'notify': {
      const deliverAfter = a.frequency === 'immediately' ? ctx.now : nextDigestTime(a.frequency, ctx.now, ctx.tzOffsetMinutes)
      const make = (inApp: boolean, emails: string[], items: NotifyItem[], first: RowSnapshot): PlannedAction => ({
        type: 'notify',
        inApp,
        emails,
        // In-app messages are never held back for a digest.
        frequency: a.frequency,
        subject:
          renderTemplate(a.subject?.trim() || '', first.cells, ctx) ||
          (items.length === 1 ? `${rule.name}: ${items[0].label}` : `${rule.name}: ${items.length} rows`),
        message: renderTemplate(a.message ?? '', first.cells, ctx),
        items,
        linkRowId: a.linkToRow && items.length === 1 ? items[0].rowId : null,
        deliverAfter: inApp && emails.length === 0 ? ctx.now : deliverAfter,
      })
      // One planned notification per distinct recipient set, so a weekly reminder over 40 rows is one message.
      if (rows.length === 1) {
        const r = resolveRecipients(a.recipients, rows[0].cells)
        if (!r.inApp && r.emails.length === 0) {
          notes.push('No recipients: the contact cells are empty')
          return []
        }
        return [make(r.inApp, r.emails, [notifyItem(a, rows[0], ctx)], rows[0])]
      }
      const byEmail = new Map<string, RowSnapshot[]>()
      const ownerRows: RowSnapshot[] = []
      for (const row of rows) {
        const r = resolveRecipients(a.recipients, row.cells)
        if (r.inApp) ownerRows.push(row)
        for (const e of r.emails) byEmail.set(e, [...(byEmail.get(e) ?? []), row])
      }
      const out: PlannedAction[] = []
      if (ownerRows.length > 0) out.push(make(true, [], ownerRows.map((r) => notifyItem(a, r, ctx)), ownerRows[0]))
      for (const [email, rs] of byEmail) out.push(make(false, [email], rs.map((r) => notifyItem(a, r, ctx)), rs[0]))
      if (out.length === 0) notes.push('No recipients: the contact cells are empty')
      return out
    }
    case 'update_request':
    case 'approval': {
      const out: PlannedAction[] = []
      for (const row of rows) {
        const r = resolveRecipients(a.recipients, row.cells)
        if (r.emails.length === 0) {
          notes.push(`No e-mail address for "${rowLabel(row.cells, ctx)}"`)
          continue
        }
        const message = renderTemplate(a.message ?? '', row.cells, ctx)
        if (a.type === 'update_request') {
          out.push({ type: 'update_request', rowId: row.id, emails: r.emails, columnIds: a.columnIds, message, expiresInDays: a.expiresInDays })
        } else {
          out.push({
            type: 'approval',
            rowId: row.id,
            emails: r.emails,
            statusColumnId: a.statusColumnId,
            pendingValue: a.pendingValue?.trim() ? a.pendingValue.trim() : null,
            approvedValue: a.approvedValue,
            declinedValue: a.declinedValue,
            showColumnIds: a.showColumnIds ?? [],
            message,
            expiresInDays: a.expiresInDays,
          })
        }
      }
      return out
    }
    case 'lock':
      return rows.map((r) => ({ type: 'lock', rowId: r.id, locked: a.locked }))
    case 'move':
    case 'copy':
      return rows.map((r) => ({ type: a.type, rowId: r.id, targetSheetId: a.targetSheetId }))
    case 'record_date': {
      const col = ctx.columns.find((c) => c.id === a.columnId)
      if (!col || col.type !== 'DATE') {
        notes.push('The column to record the date in is missing or is not a date column')
        return []
      }
      return rows.map((r) => ({ type: 'set_cell', rowId: r.id, columnId: a.columnId, value: today }))
    }
  }
}

/** Actions that write to the row (or take it away) must not run on a locked row. */
function lockedOut(actions: readonly PlannedAction[], ctx: EngineContext): boolean {
  return actions.some((a) => (a.type === 'set_cell' || a.type === 'move') && ctx.lockedRowIds?.has(a.rowId) === true)
}

// ---- row events ----

/**
 * The runs caused by one row event. Only rules of `ctx.sheetId` are considered.
 */
export function evaluateRowEvent(rules: readonly AutomationRule[], event: SheetEvent, ctx: EngineContext, guard?: RunGuard): EvalResult {
  const out: EvalResult = { runs: [], skipped: [] }
  const row = event.kind === 'row_added' ? event.row : event.after
  const beforeCells: Cells = event.kind === 'row_changed' ? event.before.cells : {}
  const changed = changedColumns(beforeCells, row.cells, ctx.columns)
  const origin = event.origin ?? []
  const env: CondEnv = { columns: ctx.columns, cells: row.cells, before: beforeCells, today: todayIso(ctx.now, ctx.tzOffsetMinutes) }
  const seen = new Set<string>()

  for (const rule of rules) {
    if (!rule.enabled || rule.sheetId !== ctx.sheetId || seen.has(rule.id)) continue
    seen.add(rule.id)
    if (!triggerMatchesEvent(rule.trigger, event, changed, ctx.columns)) continue
    if (!evaluateGroup(rule.conditions, env)) continue

    const skip = (reason: SkippedRun['reason']) => out.skipped.push({ ruleId: rule.id, ruleName: rule.name, rowId: row.id, reason })
    if (origin.includes(rule.id)) {
      skip('loop')
      continue
    }
    if (origin.length >= MAX_CHAIN_DEPTH) {
      skip('depth')
      continue
    }
    const notes: string[] = []
    const actions = planAction(rule, [row], ctx, notes)
    if (lockedOut(actions, ctx)) {
      skip('locked')
      continue
    }
    if (guard && !guard.tryRun(rule.id)) {
      skip('throttled')
      continue
    }
    out.runs.push({ ruleId: rule.id, ruleName: rule.name, rowId: row.id, rowLabel: rowLabel(row.cells, ctx), dedupKey: null, actions, ...(notes.length ? { notes } : {}) })
  }
  return out
}

// ---- time ticks ----

/**
 * The runs due at `ctx.now` for date and schedule triggers over the sheet's current rows. Safe to call
 * as often as you like (every minute): `state.fired` / `state.lastRunAt` make each run happen once.
 */
export function evaluateTick(
  rules: readonly AutomationRule[],
  rows: readonly RowSnapshot[],
  ctx: EngineContext,
  state: TickState,
  guard?: RunGuard,
): EvalResult {
  const out: EvalResult = { runs: [], skipped: [] }
  const today = todayIso(ctx.now, ctx.tzOffsetMinutes)
  const envFor = (row: RowSnapshot): CondEnv => ({ columns: ctx.columns, cells: row.cells, today })

  for (const rule of rules) {
    if (!rule.enabled || rule.sheetId !== ctx.sheetId) continue
    const t = rule.trigger
    const throttled = (rowId: string | null) => {
      out.skipped.push({ ruleId: rule.id, ruleName: rule.name, rowId, reason: 'throttled' })
    }

    if (t.type === 'schedule') {
      const at = latestOccurrence(t, ctx.now, ctx.tzOffsetMinutes)
      if (at === null) continue
      const since = state.lastRunAt[rule.id] ?? Date.parse(rule.createdAt)
      const key = `${rule.id}:schedule:${at}`
      if (at <= since || state.fired.has(key)) continue
      if (guard && !guard.tryRun(rule.id)) {
        throttled(null)
        continue
      }
      const matching = rows.filter((r) => evaluateGroup(rule.conditions, envFor(r)))
      const notes: string[] = []
      const actions = matching.length > 0 ? planAction(rule, matching, ctx, notes) : []
      if (matching.length === 0) notes.push('No row met the conditions')
      out.runs.push({ ruleId: rule.id, ruleName: rule.name, rowId: null, rowLabel: `${matching.length} rows`, dedupKey: key, actions, ...(notes.length ? { notes } : {}) })
      continue
    }

    if (t.type === 'date') {
      for (const row of rows) {
        const date = row.cells[t.columnId]
        if (!isIsoDate(date)) continue
        if (dateTriggerTarget(date, t.when, t.days) !== today) continue
        const key = `${rule.id}:${row.id}:${date}:${today}`
        if (state.fired.has(key) || !evaluateGroup(rule.conditions, envFor(row))) continue
        if (guard && !guard.tryRun(rule.id)) {
          throttled(row.id)
          continue
        }
        const notes: string[] = []
        const actions = planAction(rule, [row], ctx, notes)
        if (lockedOut(actions, ctx)) {
          out.skipped.push({ ruleId: rule.id, ruleName: rule.name, rowId: row.id, reason: 'locked' })
          continue
        }
        out.runs.push({ ruleId: rule.id, ruleName: rule.name, rowId: row.id, rowLabel: rowLabel(row.cells, ctx), dedupKey: key, actions, ...(notes.length ? { notes } : {}) })
      }
    }
  }
  return out
}

// ---- dry run ----

export interface DryRunResult {
  /** Do the conditions hold for this row (assuming the trigger fired)? */
  conditionsPass: boolean
  conditions: ConditionOutcome[]
  /** What would happen; null when the conditions do not hold. */
  run: PlannedRun | null
}

/**
 * "What would this rule do for this row?" Assumes the trigger fires for the row: a changed / became
 * trigger is simulated by blanking the watched cell(s) in the "before" version, so conditions like
 * "changed to" can be tried. Changes nothing.
 */
export function dryRun(rule: AutomationRule, row: RowSnapshot, ctx: EngineContext): DryRunResult {
  const t = rule.trigger
  const watched = t.type === 'cell_becomes' ? [t.columnId] : t.type === 'row_changed' && t.columnIds?.length ? t.columnIds : ctx.columns.map((c) => c.id)
  const before: Cells = { ...row.cells }
  if (t.type === 'row_added') for (const id of Object.keys(before)) delete before[id]
  else if (t.type === 'row_changed' || t.type === 'cell_becomes') for (const id of watched) delete before[id]
  const env: CondEnv = {
    columns: ctx.columns,
    cells: row.cells,
    before: t.type === 'date' || t.type === 'schedule' ? undefined : before,
    today: todayIso(ctx.now, ctx.tzOffsetMinutes),
  }
  const conditions = explainGroup(rule.conditions, env, (c) => describeCondition(c, ctx.columns))
  const pass = evaluateGroup(rule.conditions, env)
  if (!pass) return { conditionsPass: false, conditions, run: null }
  const notes: string[] = []
  const actions = planAction(rule, [row], ctx, notes)
  return {
    conditionsPass: true,
    conditions,
    run: { ruleId: rule.id, ruleName: rule.name, rowId: row.id, rowLabel: rowLabel(row.cells, ctx), dedupKey: null, actions, ...(notes.length ? { notes } : {}) },
  }
}

export { describeRule } from './describe'
export { batchDigests } from './digest'
export { createRunGuard } from './guard'
