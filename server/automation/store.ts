/**
 * The server's data access for automation, over a SERVICE-ROLE Supabase client (it bypasses row-level
 * security, so every method takes the owner explicitly and nothing here is reachable by a browser).
 * Behind an interface so the scheduler and the request logic are tested without a database; the real
 * implementation is also exercised against the in-memory fake in service mode.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { automationApi, ruleFromDb, type DbRule } from '../../src/automation/db'
import type { NewNotification, RunRecord, StepResult } from '../../src/automation/execute'
import type { AutomationRule } from '../../src/automation/types'
import type { Column } from '../../src/model/validate'
import { columnFromDb, type DbColumn } from '../../src/store/persistence'
import { fetchAllPages } from '../../src/store/paging'

export interface RuleRow extends AutomationRule {
  ownerId: string
  workspaceId: string
}

export interface SheetBundle {
  id: string
  name: string
  ownerId: string
  workspaceId: string
  dependenciesEnabled: boolean
  hoursPerDay: number
  columns: Column[]
  rows: { id: string; parentId: string | null; cells: Record<string, unknown>; version: number }[]
}

export interface OwnerInfo {
  id: string
  email: string | null
  anonymous: boolean
}

export interface PendingEmailRow {
  id: string
  ownerId: string
  sheetId: string | null
  rowId: string | null
  recipientEmail: string
  frequency: 'immediately' | 'daily' | 'weekly'
  title: string
  body: string
  deliverAfter: number
}

export interface RequestRecord {
  id: string
  kind: 'update' | 'approval'
  sheetId: string
  rowId: string
  ownerId: string
  workspaceId: string
  ruleId: string | null
  email: string
  status: string
  expiresAt: number
  message: string
  columnIds: string[]
  approval: { statusColumnId: string; approvedValue: string; declinedValue: string; showColumnIds: string[] } | null
}

export interface NewRequest {
  kind: 'update' | 'approval'
  tokenHash: string
  sheetId: string
  rowId: string
  ownerId: string
  workspaceId: string
  ruleId: string | null
  email: string
  expiresAt: number
  message: string
  columnIds: string[]
  approval?: { statusColumnId: string; approvedValue: string; declinedValue: string; showColumnIds: string[] }
}

export interface AutomationStore {
  timeRules(): Promise<RuleRow[]>
  sheet(sheetId: string): Promise<SheetBundle | null>
  /** Dedup keys recorded since `sinceMs`. */
  firedKeys(sinceMs: number): Promise<Set<string>>
  touchRule(ruleId: string, atMs: number): Promise<void>
  recordRun(owner: { id: string; workspaceId: string }, run: RunRecord): Promise<boolean>
  createNotifications(ownerId: string, rows: NewNotification[], status?: 'sent' | 'pending'): Promise<void>
  /** Merges `patch` into the row's cells (optimistic on the row version) and bumps the version. */
  patchCells(rowId: string, patch: Record<string, unknown>): Promise<StepResult>
  setLock(sheetId: string, rowId: string, owner: { id: string; workspaceId: string }, locked: boolean, ruleId: string | null): Promise<void>
  copyRow(rowId: string, targetSheetId: string, move: boolean): Promise<void>
  lockedRows(sheetId: string): Promise<Set<string>>
  owner(userId: string): Promise<OwnerInfo | null>
  emailsSentSince(ownerId: string, sinceMs: number): Promise<number>
  pendingEmails(nowMs: number, limit: number): Promise<PendingEmailRow[]>
  markEmails(ids: string[], status: 'sent' | 'simulated' | 'failed' | 'skipped', error: string | null, atMs: number): Promise<void>
  // requests
  insertRequest(r: NewRequest): Promise<string>
  requestByHash(kind: 'update' | 'approval', tokenHash: string): Promise<RequestRecord | null>
  /** pending -> `to`, once: false when someone else got there first. */
  claimRequest(kind: 'update' | 'approval', id: string, to: string, atMs: number, extra?: { response?: unknown; comment?: string | null }): Promise<boolean>
  /** Undo a claim whose write failed. */
  reopenRequest(kind: 'update' | 'approval', id: string): Promise<void>
  expireRequest(kind: 'update' | 'approval', id: string): Promise<void>
}

const iso = (ms: number) => new Date(ms).toISOString()
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : 0)

function must<T>(res: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data
}

export function createSupabaseStore(db: SupabaseClient): AutomationStore {
  const table = (kind: 'update' | 'approval') => (kind === 'update' ? 'update_requests' : 'approval_requests')

  return {
    async timeRules() {
      const rows = await fetchAllPages<DbRule & { owner_id: string; workspace_id: string }>((from, to) =>
        db
          .from('automation_rules')
          .select('id, sheet_id, owner_id, workspace_id, name, enabled, trigger, conditions, action, created_at, last_run_at')
          .eq('enabled', true)
          .order('created_at')
          .order('id')
          .range(from, to),
      )
      return rows
        .filter((r) => r.trigger.type === 'date' || r.trigger.type === 'schedule')
        .map((r) => ({ ...ruleFromDb(r), ownerId: r.owner_id, workspaceId: r.workspace_id }))
    },

    async sheet(sheetId) {
      const sheet = must(await db.from('sheets').select('id, name, owner_id, workspace_id, dependencies_enabled, calendar').eq('id', sheetId).range(0, 0), 'sheet') as {
        id: string
        name: string
        owner_id: string
        workspace_id: string
        dependencies_enabled: boolean
        calendar: { hoursPerDay?: number } | null
      }[]
      if (sheet.length === 0) return null
      const [cols, rows] = await Promise.all([
        fetchAllPages<DbColumn>((from, to) => db.from('columns').select('*').eq('sheet_id', sheetId).order('position').order('id').range(from, to)),
        fetchAllPages<{ id: string; parent_id: string | null; cells: Record<string, unknown> | null; version: number }>((from, to) =>
          db.from('rows').select('id, parent_id, cells, version').eq('sheet_id', sheetId).order('id').range(from, to),
        ),
      ])
      const s = sheet[0]
      return {
        id: s.id,
        name: s.name,
        ownerId: s.owner_id,
        workspaceId: s.workspace_id,
        dependenciesEnabled: s.dependencies_enabled,
        hoursPerDay: s.calendar?.hoursPerDay ?? 8,
        columns: cols.map(columnFromDb),
        rows: rows.map((r) => ({ id: r.id, parentId: r.parent_id, cells: r.cells ?? {}, version: r.version })),
      }
    },

    async firedKeys(sinceMs) {
      const rows = must(
        await db.from('automation_runs').select('id, dedup_key').gte('created_at', iso(sinceMs)).order('created_at', { ascending: false }).range(0, 4999),
        'fired keys',
      ) as { dedup_key: string | null }[]
      return new Set(rows.flatMap((r) => (r.dedup_key ? [r.dedup_key] : [])))
    },

    async touchRule(ruleId, atMs) {
      must(await db.from('automation_rules').update({ last_run_at: iso(atMs) }).eq('id', ruleId), 'touch rule')
    },

    async recordRun(owner, r) {
      const res = await db.from('automation_runs').insert({
        rule_id: r.ruleId,
        rule_name: r.ruleName,
        sheet_id: r.sheetId,
        owner_id: owner.id,
        workspace_id: owner.workspaceId,
        row_id: r.rowId,
        source: r.source,
        outcome: r.outcome,
        detail: r.detail,
        dedup_key: r.dedupKey,
      })
      if (res.error) {
        if (res.error.code === '23505') return false
        throw new Error(`record run: ${res.error.message}`)
      }
      return true
    },

    async createNotifications(ownerId, rows, status) {
      if (rows.length === 0) return
      must(
        await db.from('notifications').insert(
          rows.map((n) => ({
            owner_id: ownerId,
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
            deliver_after: iso(n.deliverAfter),
            delivery_status: status ?? (n.channel === 'app' ? 'sent' : 'pending'),
          })),
        ),
        'create notifications',
      )
    },

    async patchCells(rowId, patch) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = must(await db.from('rows').select('cells, version').eq('id', rowId).range(0, 0), 'read row') as { cells: Record<string, unknown> | null; version: number }[]
        if (cur.length === 0) return { ok: false, error: 'The row no longer exists.' }
        const cells = { ...(cur[0].cells ?? {}), ...patch }
        const done = must(
          await db.from('rows').update({ cells, version: cur[0].version + 1 }).eq('id', rowId).eq('version', cur[0].version).select('id'),
          'write row',
        ) as { id: string }[]
        if (done.length === 1) return { ok: true }
      }
      return { ok: false, error: 'The row was changed at the same time; try again.' }
    },

    async setLock(sheetId, rowId, owner, locked, ruleId) {
      if (locked) {
        const res = await db.from('row_locks').insert({ row_id: rowId, sheet_id: sheetId, owner_id: owner.id, workspace_id: owner.workspaceId, rule_id: ruleId })
        if (res.error && res.error.code !== '23505') throw new Error(`lock: ${res.error.message}`)
      } else {
        must(await db.from('row_locks').delete().eq('row_id', rowId), 'unlock')
      }
    },

    async lockedRows(sheetId) {
      const rows = must(await db.from('row_locks').select('row_id').eq('sheet_id', sheetId).range(0, 4999), 'locks') as { row_id: string }[]
      return new Set(rows.map((r) => r.row_id))
    },

    async copyRow(rowId, targetSheetId, move) {
      await automationApi(db).copyRow(rowId, targetSheetId, move)
    },

    async owner(userId) {
      const { data, error } = await db.auth.admin.getUserById(userId)
      if (error || !data.user) return null
      const u = data.user as { id: string; email?: string | null; is_anonymous?: boolean }
      return { id: u.id, email: u.email ? u.email : null, anonymous: u.is_anonymous === true || !u.email }
    },

    async emailsSentSince(ownerId, sinceMs) {
      const rows = must(
        await db
          .from('notifications')
          .select('id')
          .eq('owner_id', ownerId)
          .eq('channel', 'email')
          .eq('delivery_status', 'sent')
          .gte('delivered_at', iso(sinceMs))
          .range(0, 9999),
        'count e-mails',
      ) as unknown[]
      return rows.length
    },

    async pendingEmails(nowMs, limit) {
      const rows = must(
        await db
          .from('notifications')
          .select('id, owner_id, sheet_id, row_id, recipient_email, frequency, title, body, deliver_after')
          .eq('channel', 'email')
          .eq('delivery_status', 'pending')
          .lte('deliver_after', iso(nowMs))
          .order('deliver_after')
          .range(0, limit - 1),
        'pending e-mails',
      ) as {
        id: string
        owner_id: string
        sheet_id: string | null
        row_id: string | null
        recipient_email: string
        frequency: 'immediately' | 'daily' | 'weekly'
        title: string
        body: string
        deliver_after: string
      }[]
      return rows.map((r) => ({
        id: r.id,
        ownerId: r.owner_id,
        sheetId: r.sheet_id,
        rowId: r.row_id,
        recipientEmail: r.recipient_email,
        frequency: r.frequency,
        title: r.title,
        body: r.body,
        deliverAfter: ms(r.deliver_after),
      }))
    },

    async markEmails(ids, status, error, atMs) {
      if (ids.length === 0) return
      must(
        await db
          .from('notifications')
          .update({ delivery_status: status, delivered_at: iso(atMs), delivery_error: error ? error.slice(0, 300) : null })
          .in('id', ids),
        'mark e-mails',
      )
    },

    async insertRequest(r) {
      const common = {
        sheet_id: r.sheetId,
        row_id: r.rowId,
        owner_id: r.ownerId,
        workspace_id: r.workspaceId,
        rule_id: r.ruleId,
        token_hash: r.tokenHash,
        expires_at: iso(r.expiresAt),
        message: r.message,
      }
      const row: Record<string, unknown> =
        r.kind === 'update'
          ? { ...common, recipient_email: r.email, column_ids: r.columnIds }
          : {
              ...common,
              approver_email: r.email,
              status_column_id: r.approval!.statusColumnId,
              approved_value: r.approval!.approvedValue,
              declined_value: r.approval!.declinedValue,
              show_column_ids: r.approval!.showColumnIds,
            }
      return (must(await db.from(table(r.kind)).insert(row).select('id').single(), 'create request') as { id: string }).id
    },

    async requestByHash(kind, tokenHash) {
      const rows = must(await db.from(table(kind)).select('*').eq('token_hash', tokenHash).range(0, 0), 'find request') as Record<string, unknown>[]
      if (rows.length === 0) return null
      const r = rows[0]
      return {
        id: r.id as string,
        kind,
        sheetId: r.sheet_id as string,
        rowId: r.row_id as string,
        ownerId: r.owner_id as string,
        workspaceId: r.workspace_id as string,
        ruleId: (r.rule_id as string | null) ?? null,
        email: (kind === 'update' ? r.recipient_email : r.approver_email) as string,
        status: r.status as string,
        expiresAt: ms(r.expires_at as string),
        message: (r.message as string) ?? '',
        columnIds: kind === 'update' ? ((r.column_ids as string[]) ?? []) : [],
        approval:
          kind === 'approval'
            ? {
                statusColumnId: r.status_column_id as string,
                approvedValue: r.approved_value as string,
                declinedValue: r.declined_value as string,
                showColumnIds: (r.show_column_ids as string[]) ?? [],
              }
            : null,
      }
    },

    async claimRequest(kind, id, to, atMs, extra) {
      const patch =
        kind === 'update'
          ? { status: to, responded_at: iso(atMs), response: extra?.response ?? null }
          : { status: to, decided_at: iso(atMs), decision_comment: extra?.comment ?? null }
      const done = must(await db.from(table(kind)).update(patch).eq('id', id).eq('status', 'pending').select('id'), 'claim request') as { id: string }[]
      return done.length === 1
    },

    async reopenRequest(kind, id) {
      const patch = kind === 'update' ? { status: 'pending', responded_at: null, response: null } : { status: 'pending', decided_at: null, decision_comment: null }
      must(await db.from(table(kind)).update(patch).eq('id', id), 'reopen request')
    },

    async expireRequest(kind, id) {
      must(await db.from(table(kind)).update({ status: 'expired' }).eq('id', id).eq('status', 'pending'), 'expire request')
    },
  }
}
