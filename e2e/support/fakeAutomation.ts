/**
 * The automation part of the in-memory fake backend (supabase/migrations/0009_automation.sql): tables
 * `automation_rules`, `automation_runs`, `notifications`, `update_requests`, `approval_requests`,
 * `row_locks` and the function `copy_row_to_sheet`. Kept in its own file so the main fake only needs a
 * few hook calls. Mirrors the grants too: runs are append-only, notifications can only change
 * `read_at`, requests can only be revoked (and never read with their token hash), and the browser
 * cannot create requests (the server does). Like the rest of the fake it is NOT a security test:
 * `src/db/automation.test.ts` runs the real policies against PGlite.
 */
import type { DbRecord, FakeError, FakeResult, FakeState } from './fakeSupabase'

export const AUTOMATION_TABLES = ['automation_rules', 'automation_runs', 'notifications', 'update_requests', 'approval_requests', 'row_locks'] as const
export type AutomationTable = (typeof AUTOMATION_TABLES)[number]

interface ColumnSpec {
  default?: (ctx: { uid: string; now: () => string }) => unknown
  notNull?: boolean
}
const uuid = () => crypto.randomUUID()
const uid = ({ uid }: { uid: string }) => uid
const now = ({ now }: { now: () => string }) => now()
const nul = () => null

export const AUTOMATION_SCHEMA: Record<AutomationTable, Record<string, ColumnSpec>> = {
  automation_rules: {
    id: { default: uuid, notNull: true },
    sheet_id: { notNull: true },
    owner_id: { default: uid, notNull: true },
    workspace_id: { default: uid, notNull: true },
    name: { notNull: true },
    enabled: { default: () => true, notNull: true },
    trigger: { notNull: true },
    conditions: { default: nul },
    action: { notNull: true },
    created_at: { default: now, notNull: true },
    updated_at: { default: now, notNull: true },
    last_run_at: { default: nul },
  },
  automation_runs: {
    id: { default: uuid, notNull: true },
    rule_id: { default: nul },
    rule_name: { notNull: true },
    sheet_id: { notNull: true },
    owner_id: { default: uid, notNull: true },
    workspace_id: { default: uid, notNull: true },
    row_id: { default: nul },
    source: { notNull: true },
    outcome: { notNull: true },
    detail: { default: () => ({}), notNull: true },
    dedup_key: { default: nul },
    created_at: { default: now, notNull: true },
  },
  notifications: {
    id: { default: uuid, notNull: true },
    owner_id: { default: uid, notNull: true },
    sheet_id: { default: nul },
    row_id: { default: nul },
    rule_id: { default: nul },
    channel: { notNull: true },
    kind: { default: () => 'rule', notNull: true },
    recipient_email: { default: nul },
    title: { notNull: true },
    body: { default: () => '', notNull: true },
    payload: { default: () => ({}), notNull: true },
    frequency: { default: () => 'immediately', notNull: true },
    deliver_after: { default: now, notNull: true },
    delivery_status: { default: () => 'pending', notNull: true },
    delivered_at: { default: nul },
    delivery_error: { default: nul },
    read_at: { default: nul },
    created_at: { default: now, notNull: true },
  },
  update_requests: {
    id: { default: uuid, notNull: true },
    sheet_id: { notNull: true },
    row_id: { notNull: true },
    owner_id: { default: uid, notNull: true },
    workspace_id: { default: uid, notNull: true },
    rule_id: { default: nul },
    token_hash: { notNull: true },
    recipient_email: { notNull: true },
    column_ids: { notNull: true },
    message: { default: () => '', notNull: true },
    expires_at: { notNull: true },
    status: { default: () => 'pending', notNull: true },
    responded_at: { default: nul },
    response: { default: nul },
    created_at: { default: now, notNull: true },
  },
  approval_requests: {
    id: { default: uuid, notNull: true },
    sheet_id: { notNull: true },
    row_id: { notNull: true },
    owner_id: { default: uid, notNull: true },
    workspace_id: { default: uid, notNull: true },
    rule_id: { default: nul },
    token_hash: { notNull: true },
    approver_email: { notNull: true },
    status_column_id: { notNull: true },
    approved_value: { notNull: true },
    declined_value: { notNull: true },
    show_column_ids: { default: () => [], notNull: true },
    message: { default: () => '', notNull: true },
    expires_at: { notNull: true },
    status: { default: () => 'pending', notNull: true },
    decision_comment: { default: nul },
    decided_at: { default: nul },
    created_at: { default: now, notNull: true },
  },
  // No `id`: the primary key is row_id.
  row_locks: {
    row_id: { notNull: true },
    sheet_id: { notNull: true },
    owner_id: { default: uid, notNull: true },
    workspace_id: { default: uid, notNull: true },
    rule_id: { default: nul },
    locked_at: { default: now, notNull: true },
  },
}

const pgError = (message: string, code: string): FakeError => ({ message, code, details: null, hint: null })
const denied = (table: string): FakeError => pgError(`permission denied for table ${table}`, '42501')

export const isAutomationTable = (t: string): t is AutomationTable => (AUTOMATION_TABLES as readonly string[]).includes(t)

const REQUEST_TABLES = ['update_requests', 'approval_requests']
const TRIGGERS = ['row_added', 'row_changed', 'cell_becomes', 'date', 'schedule']
const ACTIONS = ['notify', 'update_request', 'approval', 'lock', 'move', 'copy', 'record_date']

/** Privileges of the signed-in role: what the grants of 0009 allow, before any row is looked at. */
export function automationAccessError(table: string, op: 'select' | 'insert' | 'upsert' | 'update' | 'delete', columns?: string, patch?: DbRecord): FakeError | null {
  if (!isAutomationTable(table)) return null
  if (table === 'automation_runs' && (op === 'update' || op === 'delete')) return denied(table)
  if (REQUEST_TABLES.includes(table)) {
    if (op === 'insert' || op === 'upsert' || op === 'delete') return denied(table)
    if (op === 'select' && (columns === '*' || (columns ?? '').split(',').some((c) => c.trim() === 'token_hash'))) return denied(table)
    if (op === 'update' && Object.keys(patch ?? {}).some((k) => k !== 'status')) return denied(table)
  }
  if (table === 'notifications' && op === 'update' && Object.keys(patch ?? {}).some((k) => k !== 'read_at')) return denied(table)
  return null
}

/** Check constraints of the new tables. Null when the row is fine. */
export function automationRowError(table: string, row: DbRecord, state: FakeState): FakeError | null {
  if (!isAutomationTable(table)) return null
  const bad = (why: string) => pgError(`new row for relation "${table}" violates check constraint "${why}"`, '23514')
  const obj = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v)
  switch (table) {
    case 'automation_rules':
      if (typeof row.name !== 'string' || row.name.trim() === '' || row.name.length > 100) return bad('automation_rules_name_check')
      if (!obj(row.trigger) || !TRIGGERS.includes(String((row.trigger as DbRecord).type))) return bad('automation_rules_trigger_check')
      if (!obj(row.action) || !ACTIONS.includes(String((row.action as DbRecord).type))) return bad('automation_rules_action_check')
      if (row.conditions != null && !obj(row.conditions)) return bad('automation_rules_conditions_check')
      return null
    case 'automation_runs':
      if (!['browser', 'server', 'test'].includes(String(row.source))) return bad('automation_runs_source_check')
      if (!['done', 'skipped', 'error', 'dry_run'].includes(String(row.outcome))) return bad('automation_runs_outcome_check')
      return null
    case 'notifications':
      if (!['app', 'email'].includes(String(row.channel))) return bad('notifications_channel_check')
      if ((row.channel === 'email') !== (row.recipient_email != null)) return bad('notifications_check')
      if (typeof row.title !== 'string' || row.title.length > 200) return bad('notifications_title_check')
      if (!['immediately', 'daily', 'weekly'].includes(String(row.frequency))) return bad('notifications_frequency_check')
      return null
    case 'row_locks': {
      const ok = state.tables.rows.some((r) => r.id === row.row_id && r.sheet_id === row.sheet_id)
      return ok ? null : pgError('insert or update on table "row_locks" violates foreign key constraint', '23503')
    }
    default:
      return null
  }
}

/** Unique keys: row_locks primary key, the run log's dedup key. */
export function automationUniqueError(table: string, row: DbRecord, others: DbRecord[]): FakeError | null {
  if (table === 'row_locks' && others.some((r) => r !== row && r.row_id === row.row_id)) {
    return pgError('duplicate key value violates unique constraint "row_locks_pkey"', '23505')
  }
  if (table === 'automation_runs' && row.dedup_key != null && others.some((r) => r !== row && r.dedup_key === row.dedup_key)) {
    return pgError('duplicate key value violates unique constraint "automation_runs_dedup_key_idx"', '23505')
  }
  return null
}

/** UPDATE of a request is limited to pending ones being revoked (the policy's `using` / `with check`). */
export function automationUpdatable(table: string, row: DbRecord, patch: DbRecord): boolean {
  if (!REQUEST_TABLES.includes(table)) return true
  return row.status === 'pending' && patch.status === 'revoked'
}

/** `on delete cascade`: deleting sheets or rows removes what hangs off them. */
export function cascadeAutomation(state: FakeState, table: string, ids: Set<unknown>): void {
  if (table === 'sheets') {
    for (const t of AUTOMATION_TABLES) state.tables[t] = state.tables[t].filter((r) => !ids.has(r.sheet_id))
  } else if (table === 'rows') {
    for (const t of ['update_requests', 'approval_requests', 'row_locks'] as const) state.tables[t] = state.tables[t].filter((r) => !ids.has(r.row_id))
  }
}

const norm = (s: unknown) => String(s ?? '').toLowerCase()

/** `copy_row_to_sheet(p_row_id, p_target_sheet_id, p_position, p_move)`; all or nothing. */
export function copyRowToSheet(state: FakeState, uid: string | null, args: Record<string, unknown>): FakeResult<string | null> {
  const fail = (message: string, code: string): FakeResult<string | null> => ({ data: null, error: pgError(message, code) })
  const src = state.tables.rows.find((r) => r.id === args.p_row_id && (uid === null || r.owner_id === uid))
  if (!src) return fail('row not found', 'P0002')
  if (src.sheet_id === args.p_target_sheet_id) return fail('the target must be a different sheet', '22023')
  const target = state.tables.sheets.find((s) => s.id === args.p_target_sheet_id && s.owner_id === src.owner_id)
  if (!target) return fail('target sheet not found', 'P0002')
  if (state.tables.rows.some((r) => r.parent_id === src.id)) return fail('a row with sub-rows cannot be copied or moved', '22023')
  const cells: Record<string, unknown> = {}
  const srcCells = (src.cells ?? {}) as Record<string, unknown>
  const targetCols = state.tables.columns.filter((c) => c.sheet_id === target.id)
  for (const s of state.tables.columns.filter((c) => c.sheet_id === src.sheet_id && c.type !== 'PREDECESSOR')) {
    if (!(String(s.id) in srcCells)) continue
    const t = targetCols.find((c) => norm(c.title) === norm(s.title) && c.type === s.type)
    if (t) cells[String(t.id)] = structuredClone(srcCells[String(s.id)])
  }
  const id = crypto.randomUUID()
  state.tables.rows.push({ id, sheet_id: target.id, owner_id: src.owner_id, workspace_id: src.workspace_id, parent_id: null, position: args.p_position, cells, version: 0 })
  if (args.p_move === true) state.tables.rows = state.tables.rows.filter((r) => r.id !== src.id)
  return { data: id, error: null }
}
