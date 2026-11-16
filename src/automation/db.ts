/** Browser-side data access for automation (rules, run log, notifications, requests, locks). */
import type { SupabaseClient } from '@supabase/supabase-js'
import { generateKeyBetween } from 'fractional-indexing'
import { fetchAllPages } from '../store/paging'
import type { NewNotification, RunRecord } from './execute'
import type { Action, AutomationRule, ConditionGroup, Trigger } from './types'

export interface DbRule {
  id: string
  sheet_id: string
  name: string
  enabled: boolean
  trigger: Trigger
  conditions: ConditionGroup | null
  action: Action
  created_at: string
  last_run_at: string | null
}

export function ruleFromDb(r: DbRule): AutomationRule {
  return {
    id: r.id,
    sheetId: r.sheet_id,
    name: r.name,
    enabled: r.enabled,
    trigger: r.trigger,
    conditions: r.conditions,
    action: r.action,
    createdAt: r.created_at,
    lastRunAt: r.last_run_at,
  }
}

export interface RuleDraft {
  sheetId: string
  name: string
  enabled: boolean
  trigger: Trigger
  conditions: ConditionGroup | null
  action: Action
}

const RULE_COLUMNS = 'id, sheet_id, name, enabled, trigger, conditions, action, created_at, last_run_at'

export interface DbNotification {
  id: string
  sheet_id: string | null
  row_id: string | null
  rule_id: string | null
  channel: 'app' | 'email'
  kind: string
  title: string
  body: string
  payload: { ruleName?: string; sheetName?: string; items?: { rowId: string; label: string }[]; linkRowId?: string | null }
  read_at: string | null
  created_at: string
}
const NOTIFICATION_COLUMNS = 'id, sheet_id, row_id, rule_id, channel, kind, title, body, payload, read_at, created_at'

export interface DbRun {
  id: string
  rule_id: string | null
  rule_name: string
  row_id: string | null
  source: 'browser' | 'server' | 'test'
  outcome: 'done' | 'skipped' | 'error' | 'dry_run'
  detail: Record<string, unknown>
  created_at: string
}
const RUN_COLUMNS = 'id, rule_id, rule_name, row_id, source, outcome, detail, created_at'

export interface RequestRow {
  kind: 'update' | 'approval'
  id: string
  rowId: string
  recipient: string
  status: string
  createdAt: string
  expiresAt: string
  respondedAt: string | null
  /** Approvals: the comment given with the decision. */
  comment: string | null
}

function check<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data
}

export type AutomationApi = ReturnType<typeof automationApi>

export function automationApi(client: SupabaseClient) {
  return {
    async listRules(sheetId: string): Promise<AutomationRule[]> {
      const rows = await fetchAllPages<DbRule>((from, to) =>
        client.from('automation_rules').select(RULE_COLUMNS).eq('sheet_id', sheetId).order('created_at', { ascending: true }).order('id').range(from, to),
      )
      return rows.map(ruleFromDb)
    },

    async createRule(d: RuleDraft): Promise<AutomationRule> {
      const r = check(
        await client
          .from('automation_rules')
          .insert({ sheet_id: d.sheetId, name: d.name, enabled: d.enabled, trigger: d.trigger, conditions: d.conditions, action: d.action })
          .select(RULE_COLUMNS)
          .single(),
      ) as DbRule
      return ruleFromDb(r)
    },

    async updateRule(id: string, d: Omit<RuleDraft, 'sheetId'>): Promise<void> {
      check(
        await client
          .from('automation_rules')
          .update({ name: d.name, enabled: d.enabled, trigger: d.trigger, conditions: d.conditions, action: d.action, updated_at: new Date().toISOString() })
          .eq('id', id),
      )
    },

    async setEnabled(id: string, enabled: boolean): Promise<void> {
      check(await client.from('automation_rules').update({ enabled, updated_at: new Date().toISOString() }).eq('id', id))
    },

    async deleteRule(id: string): Promise<void> {
      check(await client.from('automation_rules').delete().eq('id', id))
    },

    async touchRule(id: string, at: Date): Promise<void> {
      check(await client.from('automation_rules').update({ last_run_at: at.toISOString() }).eq('id', id))
    },

    // ---- run log ----

    /** Appends a run. False when its dedup key was already recorded. */
    async insertRun(r: RunRecord): Promise<boolean> {
      const res = await client.from('automation_runs').insert({
        rule_id: r.ruleId,
        rule_name: r.ruleName,
        sheet_id: r.sheetId,
        row_id: r.rowId,
        source: r.source,
        outcome: r.outcome,
        detail: r.detail,
        dedup_key: r.dedupKey,
      })
      if (res.error) {
        if (res.error.code === '23505') return false
        throw new Error(res.error.message)
      }
      return true
    },

    async listRuns(sheetId: string, limit = 50): Promise<DbRun[]> {
      return check(
        await client.from('automation_runs').select(RUN_COLUMNS).eq('sheet_id', sheetId).order('created_at', { ascending: false }).range(0, limit - 1),
      ) as DbRun[]
    },

    // ---- notifications ----

    async createNotifications(rows: NewNotification[]): Promise<void> {
      if (rows.length === 0) return
      check(
        await client.from('notifications').insert(
          rows.map((n) => ({
            channel: n.channel,
            kind: n.kind,
            sheet_id: n.sheetId,
            row_id: n.rowId,
            rule_id: n.ruleId,
            recipient_email: n.recipientEmail,
            title: n.title.slice(0, 200),
            body: n.body,
            payload: n.payload,
            frequency: n.frequency,
            deliver_after: new Date(n.deliverAfter).toISOString(),
            delivery_status: n.channel === 'app' ? 'sent' : 'pending',
          })),
        ),
      )
    },

    /** The newest in-app notifications first. */
    async listNotifications(limit = 50): Promise<DbNotification[]> {
      return check(
        await client.from('notifications').select(NOTIFICATION_COLUMNS).eq('channel', 'app').order('created_at', { ascending: false }).range(0, limit - 1),
      ) as DbNotification[]
    },

    async markRead(ids: string[]): Promise<void> {
      if (ids.length === 0) return
      check(await client.from('notifications').update({ read_at: new Date().toISOString() }).in('id', ids))
    },

    async deleteNotifications(ids: string[]): Promise<void> {
      if (ids.length === 0) return
      check(await client.from('notifications').delete().in('id', ids))
    },

    // ---- locks ----

    /** Ids of the locked rows of a sheet (at most 1000, the size of one response). */
    async listLocks(sheetId: string): Promise<string[]> {
      const rows = check(await client.from('row_locks').select('row_id').eq('sheet_id', sheetId).order('row_id').range(0, 999)) as { row_id: string }[]
      return rows.map((r) => r.row_id)
    },

    async lockRow(sheetId: string, rowId: string, ruleId: string | null): Promise<void> {
      const res = await client.from('row_locks').insert({ row_id: rowId, sheet_id: sheetId, rule_id: ruleId })
      if (res.error && res.error.code !== '23505') throw new Error(res.error.message) // already locked is fine
    },

    async unlockRow(rowId: string): Promise<void> {
      check(await client.from('row_locks').delete().eq('row_id', rowId))
    },

    // ---- requests ----

    async listRequests(sheetId: string): Promise<RequestRow[]> {
      const [u, a] = await Promise.all([
        client
          .from('update_requests')
          .select('id, row_id, recipient_email, status, created_at, expires_at, responded_at')
          .eq('sheet_id', sheetId)
          .order('created_at', { ascending: false })
          .range(0, 99),
        client
          .from('approval_requests')
          .select('id, row_id, approver_email, status, created_at, expires_at, decided_at, decision_comment')
          .eq('sheet_id', sheetId)
          .order('created_at', { ascending: false })
          .range(0, 99),
      ])
      const ur = check(u) as { id: string; row_id: string; recipient_email: string; status: string; created_at: string; expires_at: string; responded_at: string | null }[]
      const ar = check(a) as { id: string; row_id: string; approver_email: string; status: string; created_at: string; expires_at: string; decided_at: string | null; decision_comment: string | null }[]
      const out: RequestRow[] = [
        ...ur.map((r) => ({ kind: 'update' as const, id: r.id, rowId: r.row_id, recipient: r.recipient_email, status: r.status, createdAt: r.created_at, expiresAt: r.expires_at, respondedAt: r.responded_at, comment: null })),
        ...ar.map((r) => ({ kind: 'approval' as const, id: r.id, rowId: r.row_id, recipient: r.approver_email, status: r.status, createdAt: r.created_at, expiresAt: r.expires_at, respondedAt: r.decided_at, comment: r.decision_comment })),
      ]
      return out.sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))
    },

    async revokeRequest(kind: 'update' | 'approval', id: string): Promise<void> {
      check(await client.from(kind === 'update' ? 'update_requests' : 'approval_requests').update({ status: 'revoked' }).eq('id', id))
    },

    // ---- copy / move ----

    /** Other sheets of the user, for the move / copy action. */
    async listSheets(): Promise<{ id: string; name: string }[]> {
      return fetchAllPages<{ id: string; name: string }>((from, to) => client.from('sheets').select('id, name').order('name').order('id').range(from, to))
    },

    /** Copies a row to the end of another sheet; `move` also deletes the original (the browser deletes it itself, through the store). */
    async copyRow(rowId: string, targetSheetId: string, move = false): Promise<string> {
      const positions = (await fetchAllPages<{ id: string; position: string; parent_id: string | null }>((from, to) =>
        client.from('rows').select('id, position, parent_id').eq('sheet_id', targetSheetId).order('id').range(from, to),
      )) as { position: string; parent_id: string | null }[]
      const top = positions.filter((p) => p.parent_id == null).map((p) => p.position)
      const last = top.reduce<string | null>((m, p) => (m === null || p > m ? p : m), null)
      const position = generateKeyBetween(last, null)
      const res = await client.rpc('copy_row_to_sheet', { p_row_id: rowId, p_target_sheet_id: targetSheetId, p_position: position, p_move: move })
      return check(res) as string
    },
  }
}
