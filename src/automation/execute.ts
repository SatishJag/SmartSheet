/**
 * Carrying out what the engine planned. The same code runs in the browser (for the signed-in user's
 * own edits), on the server (time based triggers) and as the "test run": each supplies an
 * `ExecBackend` that does the real work (or, for a test run, nothing). Execution never throws: every
 * action reports `done` / `error` and the run is logged.
 */
import { formatValue } from './values'
import type { AutomationRule, NotifyItem, PlannedAction, PlannedRun } from './types'

/** A notification row to create (both the in-app centre and the e-mail outbox). */
export interface NewNotification {
  channel: 'app' | 'email'
  kind: 'rule' | 'update_request' | 'approval' | 'system'
  sheetId: string | null
  rowId: string | null
  ruleId: string | null
  recipientEmail: string | null
  title: string
  body: string
  payload: Record<string, unknown>
  frequency: 'immediately' | 'daily' | 'weekly'
  /** ms since epoch. */
  deliverAfter: number
}

export type StepResult = { ok: true } | { ok: false; error: string }

export interface RunRecord {
  ruleId: string
  ruleName: string
  sheetId: string
  rowId: string | null
  source: 'browser' | 'server' | 'test'
  outcome: 'done' | 'skipped' | 'error' | 'dry_run'
  detail: Record<string, unknown>
  dedupKey: string | null
}

export interface ExecBackend {
  sheetId: string
  sheetName: string
  now(): number
  createNotifications(rows: NewNotification[]): Promise<void>
  setCell(rowId: string, columnId: string, value: unknown, ruleId: string): Promise<StepResult>
  setLock(rowId: string, locked: boolean, ruleId: string): Promise<StepResult>
  moveCopy(kind: 'move' | 'copy', rowId: string, targetSheetId: string): Promise<StepResult>
  sendUpdateRequest(action: Extract<PlannedAction, { type: 'update_request' }>, rule: AutomationRule): Promise<StepResult>
  sendApproval(action: Extract<PlannedAction, { type: 'approval' }>, rule: AutomationRule): Promise<StepResult>
  /** Appends to the run log. Returns false when `dedupKey` was already recorded (someone else ran it). */
  recordRun(run: RunRecord): Promise<boolean>
}

const MAX_BODY = 4800

/** The text of a notification: the rule's message, then each row's values. */
export function notificationBody(message: string, items: readonly NotifyItem[]): string {
  const parts: string[] = []
  if (message.trim()) parts.push(message.trim())
  const multi = items.length > 1
  for (const item of items.slice(0, 25)) {
    const head = multi ? `- ${item.label}` : ''
    const lines = item.values.map((v) => `${multi ? '  ' : ''}${v.title}: ${v.value}`)
    parts.push([head, ...lines].filter(Boolean).join('\n'))
  }
  if (items.length > 25) parts.push(`...and ${items.length - 25} more rows`)
  const text = parts.join('\n\n')
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text
}

function describeStep(a: PlannedAction): string {
  switch (a.type) {
    case 'notify':
      return `notify ${[a.inApp ? 'in the app' : '', ...a.emails].filter(Boolean).join(', ')}`
    case 'update_request':
      return `update request to ${a.emails.join(', ')}`
    case 'approval':
      return `approval request to ${a.emails.join(', ')}`
    case 'set_cell':
      return `set a cell to ${formatValue(a.value)}`
    case 'lock':
      return a.locked ? 'lock the row' : 'unlock the row'
    case 'move':
    case 'copy':
      return `${a.type} the row`
  }
}

export interface RunOutcome {
  /** false when a time based run was already recorded by someone else (nothing was done). */
  claimed: boolean
  steps: { action: string; result: StepResult }[]
  /** true when every step succeeded. */
  ok: boolean
}

/**
 * Executes one planned run and logs it. For a run with a `dedupKey` the log row is written FIRST (the
 * key is unique in the database), so two servers can never both carry it out.
 */
export async function executeRun(
  run: PlannedRun,
  rule: AutomationRule,
  backend: ExecBackend,
  source: 'browser' | 'server',
): Promise<RunOutcome> {
  const base = { ruleId: rule.id, ruleName: rule.name, sheetId: backend.sheetId, rowId: run.rowId, source, dedupKey: run.dedupKey }
  const planned = run.actions.map(describeStep)
  if (run.dedupKey) {
    const claimed = await backend.recordRun({ ...base, outcome: 'done', detail: { row: run.rowLabel, planned, ...(run.notes ? { notes: run.notes } : {}) } })
    if (!claimed) return { claimed: false, steps: [], ok: true }
  }

  const steps: RunOutcome['steps'] = []
  for (const a of run.actions) {
    let result: StepResult
    try {
      result = await executeAction(a, rule, backend)
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
    }
    steps.push({ action: describeStep(a), result })
  }
  const failed = steps.filter((s) => !s.result.ok)
  const ok = failed.length === 0

  if (!run.dedupKey) {
    await backend.recordRun({
      ...base,
      outcome: ok ? 'done' : 'error',
      detail: {
        row: run.rowLabel,
        steps: steps.map((s) => ({ action: s.action, ...(s.result.ok ? {} : { error: s.result.error }) })),
        ...(run.notes ? { notes: run.notes } : {}),
      },
      dedupKey: null,
    })
  } else if (!ok) {
    // The claim row says "done"; failures are added as their own entries.
    await backend.recordRun({
      ...base,
      dedupKey: null,
      outcome: 'error',
      detail: { row: run.rowLabel, errors: failed.map((s) => ({ action: s.action, error: (s.result as { error: string }).error })) },
    })
  }
  return { claimed: true, steps, ok }
}

async function executeAction(a: PlannedAction, rule: AutomationRule, b: ExecBackend): Promise<StepResult> {
  switch (a.type) {
    case 'notify': {
      const body = notificationBody(a.message, a.items)
      const rowId = a.items.length === 1 ? a.items[0].rowId : null
      const payload = {
        ruleName: rule.name,
        sheetName: b.sheetName,
        items: a.items.map((i) => ({ rowId: i.rowId, label: i.label })),
        linkRowId: a.linkRowId,
      }
      const rows: NewNotification[] = []
      const common = { kind: 'rule' as const, sheetId: b.sheetId, rowId, ruleId: rule.id, title: a.subject, body, payload }
      if (a.inApp) rows.push({ ...common, channel: 'app', recipientEmail: null, frequency: 'immediately', deliverAfter: b.now() })
      for (const email of a.emails) rows.push({ ...common, channel: 'email', recipientEmail: email, frequency: a.frequency, deliverAfter: a.deliverAfter })
      if (rows.length === 0) return { ok: true }
      await b.createNotifications(rows)
      return { ok: true }
    }
    case 'update_request':
      return b.sendUpdateRequest(a, rule)
    case 'approval':
      return b.sendApproval(a, rule)
    case 'set_cell':
      return b.setCell(a.rowId, a.columnId, a.value, rule.id)
    case 'lock':
      return b.setLock(a.rowId, a.locked, rule.id)
    case 'move':
    case 'copy':
      return b.moveCopy(a.type, a.rowId, a.targetSheetId)
  }
}
