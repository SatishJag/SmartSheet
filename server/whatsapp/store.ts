/**
 * The WhatsApp assistant's data access over a SERVICE-ROLE Supabase client (it bypasses row-level
 * security, so every method is explicit about whose data it touches; nothing here is reachable by a
 * browser). Behind an interface so the conversation, outbox and alerts are tested without a database
 * (server/whatsapp/memoryStore.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabasePersistence, type SheetData } from '../../src/store/persistence'

export type MessageKind = 'reply' | 'alert' | 'nudge' | 'summary' | 'rule' | 'system'
export type Priority = 'HIGH' | 'MEDIUM' | 'LOW'
export type MessageStatus = 'pending' | 'sent' | 'simulated' | 'failed' | 'skipped'

export interface Contact {
  id: string
  ownerId: string
  name: string
  email: string
  phone: string
  status: 'invited' | 'active'
}

export interface Link {
  userId: string
  email: string | null
  phone: string
}

export interface SheetSettings {
  sheetId: string
  ownerId: string
  enabled: boolean
  delayAlerts: boolean
  nudges: boolean
  reminderHours: number
  maxReminders: number
  dailySummary: boolean
  summaryHour: number
  timeZone: string
  dndStart: string
  dndEnd: string
  ownerColumnId: string | null
}

/** A numbered list the person last saw: replies "N <status>" and "#N" refer to it. */
export interface ListState {
  title: string
  items: { sheetId: string; rowId: string }[]
  at: number
}

/** The task the person was last asked about (delay alert or progress check): bare 1-4 answer it. */
export interface PendingAsk {
  sheetId: string
  rowId: string
  ownerId: string
  kind: 'alert' | 'nudge'
  at: number
}

export interface SessionState {
  sheetId?: string
  /** Sheet ids offered by the last project picker, in order. */
  sheetChoices?: string[]
  awaitingSheet?: boolean
  list?: ListState
  pending?: PendingAsk
  /** When the last menu-type command was handled (a newer pending ask wins over it). */
  lastMenuAt?: number
  /** When an unknown number was last told how to link (once a day). */
  unknownToldAt?: number
  /** Timestamps of recent AI questions (rate limit). */
  aiAt?: number[]
}

export interface Session {
  state: SessionState
  lastInboundAt: number | null
}

export interface Outgoing {
  /** The account the message belongs to (log, quota); null for unknown phones. */
  ownerId: string | null
  phone: string
  body: string
  kind: MessageKind
  priority: Priority
  sheetId?: string | null
  rowId?: string | null
  dedupKey?: string | null
  /** Not before this time (ms): do-not-disturb deferral. */
  notBefore?: number
}

export interface OutRow extends Required<Omit<Outgoing, 'notBefore'>> {
  id: string
  attempts: number
}

export interface NudgeRow {
  rowId: string
  milestone: number
  phone: string
  sheetId: string
  ownerId: string
  sentCount: number
  lastSentAt: number
  answeredAt: number | null
  noResponseAt: number | null
}

export interface PendingRuleMessage {
  id: string
  ownerId: string
  sheetId: string | null
  rowId: string | null
  email: string
  title: string
  body: string
}

export interface WhatsAppStore {
  linkByPhone(phone: string): Promise<Link | null>
  linkByUser(userId: string): Promise<Link | null>
  /** Links `phone` to the user, replacing the user's previous phone and anyone else's link to this phone. */
  linkPhone(userId: string, email: string | null, phone: string): Promise<void>
  linksByEmails(emails: string[]): Promise<Link[]>
  contact(id: string): Promise<Contact | null>
  activeContactsByPhone(phone: string): Promise<Contact[]>
  /** Active contacts of `ownerId` with one of `emails`. */
  ownerContactsByEmails(ownerId: string, emails: string[]): Promise<Contact[]>
  /** Owners whose contacts include this phone (any status): used to keep the simulator to one's own numbers. */
  contactOwnersOfPhone(phone: string): Promise<string[]>
  activateContact(id: string, atMs: number): Promise<void>
  createCode(c: { hash: string; kind: 'link' | 'join'; userId?: string; contactId?: string; expiresAt: number }): Promise<void>
  /** Marks an unused, unexpired code used and returns it; null when there is no such code. */
  takeCode(hash: string, atMs: number): Promise<{ kind: 'link' | 'join'; userId: string | null; contactId: string | null } | null>

  isOptedOut(phone: string): Promise<boolean>
  setOptOut(phone: string, out: boolean): Promise<void>

  session(phone: string): Promise<Session>
  saveSession(phone: string, state: SessionState, lastInboundAt?: number): Promise<void>

  /** False when this provider message id was already recorded (Meta retries webhooks). */
  recordInbound(m: { phone: string; ownerId: string | null; body: string; providerId: string | null }): Promise<boolean>
  /** False when a message with the same dedup key exists. */
  enqueue(m: Outgoing): Promise<boolean>
  due(nowMs: number, limit: number): Promise<OutRow[]>
  markMessage(id: string, patch: { status: MessageStatus; attempts?: number; nextAttemptAt?: number; providerId?: string | null; error?: string | null; sentAt?: number | null }): Promise<void>
  sentSince(ownerId: string, sinceMs: number): Promise<number>

  ownedSheets(userId: string, limit: number): Promise<{ id: string; name: string }[]>
  sheetMeta(sheetId: string): Promise<{ id: string; name: string; ownerId: string } | null>
  loadSheet(sheetId: string): Promise<SheetData | null>
  settings(sheetId: string): Promise<SheetSettings | null>
  enabledSettings(): Promise<SheetSettings[]>
  /** Merges `patch` into the row's cells (optimistic on the row version) and bumps the version. */
  patchCells(rowId: string, patch: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }>
  isRowLocked(rowId: string): Promise<boolean>

  nudges(sheetId: string): Promise<NudgeRow[]>
  saveNudge(n: NudgeRow): Promise<void>
  answerNudges(rowId: string, phone: string, atMs: number): Promise<void>

  pendingRuleMessages(nowMs: number, limit: number): Promise<PendingRuleMessage[]>
  markRuleMessage(id: string, status: 'sent' | 'skipped' | 'failed', error: string | null, atMs: number): Promise<void>
  /** An in-app notification for the account (e.g. "Ravi updated Pour slab"). */
  notifyInApp(ownerId: string, n: { sheetId: string | null; rowId: string | null; title: string; body: string }): Promise<void>
  account(userId: string): Promise<{ email: string | null; anonymous: boolean } | null>
}

export const DEFAULT_SETTINGS: Omit<SheetSettings, 'sheetId' | 'ownerId'> = {
  enabled: true,
  delayAlerts: true,
  nudges: true,
  reminderHours: 24,
  maxReminders: 2,
  dailySummary: true,
  summaryHour: 8,
  timeZone: 'UTC',
  dndStart: '22:00',
  dndEnd: '07:00',
  ownerColumnId: null,
}

const iso = (ms: number) => new Date(ms).toISOString()
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : null)

function must<T>(res: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data
}

interface DbSettings {
  sheet_id: string
  owner_id: string
  enabled: boolean
  delay_alerts: boolean
  nudges: boolean
  reminder_hours: number
  max_reminders: number
  daily_summary: boolean
  summary_hour: number
  time_zone: string
  dnd_start: string
  dnd_end: string
  owner_column_id: string | null
}

export function settingsFromDb(r: DbSettings): SheetSettings {
  return {
    sheetId: r.sheet_id,
    ownerId: r.owner_id,
    enabled: r.enabled,
    delayAlerts: r.delay_alerts,
    nudges: r.nudges,
    reminderHours: r.reminder_hours,
    maxReminders: r.max_reminders,
    dailySummary: r.daily_summary,
    summaryHour: r.summary_hour,
    timeZone: r.time_zone,
    dndStart: r.dnd_start,
    dndEnd: r.dnd_end,
    ownerColumnId: r.owner_column_id,
  }
}

interface DbContact {
  id: string
  owner_id: string
  name: string
  email: string
  phone: string
  status: 'invited' | 'active'
}
const contactFromDb = (r: DbContact): Contact => ({ id: r.id, ownerId: r.owner_id, name: r.name, email: r.email, phone: r.phone, status: r.status })
const CONTACT_COLS = 'id, owner_id, name, email, phone, status'

export function createSupabaseWhatsAppStore(db: SupabaseClient): WhatsAppStore {
  const persistence = supabasePersistence(db)
  const linkFrom = (r: { user_id: string; email: string | null; phone: string }): Link => ({ userId: r.user_id, email: r.email, phone: r.phone })

  return {
    async linkByPhone(phone) {
      const rows = must(await db.from('whatsapp_links').select('user_id, email, phone').eq('phone', phone).range(0, 0), 'link by phone') as { user_id: string; email: string | null; phone: string }[]
      return rows[0] ? linkFrom(rows[0]) : null
    },
    async linkByUser(userId) {
      const rows = must(await db.from('whatsapp_links').select('user_id, email, phone').eq('user_id', userId).range(0, 0), 'link by user') as { user_id: string; email: string | null; phone: string }[]
      return rows[0] ? linkFrom(rows[0]) : null
    },
    async linkPhone(userId, email, phone) {
      must(await db.from('whatsapp_links').delete().or(`user_id.eq.${userId},phone.eq.${phone}`), 'unlink previous')
      must(await db.from('whatsapp_links').insert({ user_id: userId, email: email?.toLowerCase() ?? null, phone }), 'link phone')
    },
    async linksByEmails(emails) {
      if (emails.length === 0) return []
      const rows = must(await db.from('whatsapp_links').select('user_id, email, phone').in('email', emails.map((e) => e.toLowerCase())).range(0, 999), 'links by email') as { user_id: string; email: string | null; phone: string }[]
      return rows.map(linkFrom)
    },
    async contact(id) {
      const rows = must(await db.from('whatsapp_contacts').select(CONTACT_COLS).eq('id', id).range(0, 0), 'contact') as DbContact[]
      return rows[0] ? contactFromDb(rows[0]) : null
    },
    async activeContactsByPhone(phone) {
      const rows = must(await db.from('whatsapp_contacts').select(CONTACT_COLS).eq('phone', phone).eq('status', 'active').order('created_at').range(0, 99), 'contacts by phone') as DbContact[]
      return rows.map(contactFromDb)
    },
    async ownerContactsByEmails(ownerId, emails) {
      if (emails.length === 0) return []
      const rows = must(
        await db.from('whatsapp_contacts').select(CONTACT_COLS).eq('owner_id', ownerId).eq('status', 'active').in('email', emails.map((e) => e.toLowerCase())).range(0, 999),
        'contacts by email',
      ) as DbContact[]
      return rows.map(contactFromDb)
    },
    async contactOwnersOfPhone(phone) {
      const rows = must(await db.from('whatsapp_contacts').select('owner_id').eq('phone', phone).range(0, 999), 'contact owners') as { owner_id: string }[]
      return [...new Set(rows.map((r) => r.owner_id))]
    },
    async activateContact(id, at) {
      must(await db.from('whatsapp_contacts').update({ status: 'active', joined_at: iso(at) }).eq('id', id), 'activate contact')
    },
    async createCode(c) {
      must(
        await db.from('whatsapp_codes').insert({ code_hash: c.hash, kind: c.kind, user_id: c.userId ?? null, contact_id: c.contactId ?? null, expires_at: iso(c.expiresAt) }),
        'create code',
      )
    },
    async takeCode(hash, at) {
      const rows = must(
        await db.from('whatsapp_codes').update({ used_at: iso(at) }).eq('code_hash', hash).is('used_at', null).gt('expires_at', iso(at)).select('kind, user_id, contact_id'),
        'take code',
      ) as { kind: 'link' | 'join'; user_id: string | null; contact_id: string | null }[]
      return rows[0] ? { kind: rows[0].kind, userId: rows[0].user_id, contactId: rows[0].contact_id } : null
    },

    async isOptedOut(phone) {
      const rows = must(await db.from('whatsapp_optouts').select('phone').eq('phone', phone).range(0, 0), 'opt-out') as unknown[]
      return rows.length > 0
    },
    async setOptOut(phone, out) {
      if (out) {
        const res = await db.from('whatsapp_optouts').insert({ phone })
        if (res.error && res.error.code !== '23505') throw new Error(`opt out: ${res.error.message}`)
      } else must(await db.from('whatsapp_optouts').delete().eq('phone', phone), 'opt in')
    },

    async session(phone) {
      const rows = must(await db.from('whatsapp_sessions').select('state, last_inbound_at').eq('phone', phone).range(0, 0), 'session') as { state: SessionState; last_inbound_at: string | null }[]
      return rows[0] ? { state: rows[0].state ?? {}, lastInboundAt: ms(rows[0].last_inbound_at) } : { state: {}, lastInboundAt: null }
    },
    async saveSession(phone, state, lastInboundAt) {
      const row: Record<string, unknown> = { phone, state, updated_at: iso(Date.now()) }
      if (lastInboundAt !== undefined) row.last_inbound_at = iso(lastInboundAt)
      must(await db.from('whatsapp_sessions').upsert(row, { onConflict: 'phone' }), 'save session')
    },

    async recordInbound(m) {
      const res = await db.from('whatsapp_messages').insert({
        owner_id: m.ownerId,
        phone: m.phone,
        direction: 'in',
        kind: 'reply',
        body: m.body.slice(0, 8000),
        status: 'received',
        provider_id: m.providerId,
      })
      if (res.error) {
        if (res.error.code === '23505') return false
        throw new Error(`record inbound: ${res.error.message}`)
      }
      return true
    },
    async enqueue(m) {
      const res = await db.from('whatsapp_messages').insert({
        owner_id: m.ownerId,
        phone: m.phone,
        direction: 'out',
        kind: m.kind,
        priority: m.priority,
        body: m.body.slice(0, 8000),
        sheet_id: m.sheetId ?? null,
        row_id: m.rowId ?? null,
        status: 'pending',
        dedup_key: m.dedupKey ?? null,
        next_attempt_at: iso(m.notBefore ?? Date.now()),
      })
      if (res.error) {
        if (res.error.code === '23505') return false
        throw new Error(`enqueue: ${res.error.message}`)
      }
      return true
    },
    async due(nowMs, limit) {
      const rows = must(
        await db
          .from('whatsapp_messages')
          .select('id, owner_id, phone, body, kind, priority, sheet_id, row_id, dedup_key, attempts')
          .eq('status', 'pending')
          .lte('next_attempt_at', iso(nowMs))
          .order('priority') // 'HIGH' < 'LOW' < 'MEDIUM' alphabetically; re-sorted below
          .order('next_attempt_at')
          .range(0, limit - 1),
        'due messages',
      ) as { id: string; owner_id: string | null; phone: string; body: string; kind: MessageKind; priority: Priority; sheet_id: string | null; row_id: string | null; dedup_key: string | null; attempts: number }[]
      const rank: Record<Priority, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }
      return rows
        .map((r) => ({ id: r.id, ownerId: r.owner_id, phone: r.phone, body: r.body, kind: r.kind, priority: r.priority, sheetId: r.sheet_id, rowId: r.row_id, dedupKey: r.dedup_key, attempts: r.attempts }))
        .sort((a, b) => rank[a.priority] - rank[b.priority])
    },
    async markMessage(id, p) {
      const patch: Record<string, unknown> = { status: p.status }
      if (p.attempts !== undefined) patch.attempts = p.attempts
      if (p.nextAttemptAt !== undefined) patch.next_attempt_at = iso(p.nextAttemptAt)
      if (p.providerId !== undefined) patch.provider_id = p.providerId
      if (p.error !== undefined) patch.error = p.error?.slice(0, 1000) ?? null
      if (p.sentAt !== undefined) patch.sent_at = p.sentAt === null ? null : iso(p.sentAt)
      must(await db.from('whatsapp_messages').update(patch).eq('id', id), 'mark message')
    },
    async sentSince(ownerId, sinceMs) {
      const res = await db.from('whatsapp_messages').select('id', { count: 'exact', head: true }).eq('owner_id', ownerId).eq('direction', 'out').in('status', ['sent']).gte('sent_at', iso(sinceMs))
      if (res.error) throw new Error(`sent count: ${res.error.message}`)
      return res.count ?? 0
    },

    async ownedSheets(userId, limit) {
      const rows = must(await db.from('sheets').select('id, name').eq('owner_id', userId).order('created_at', { ascending: false }).range(0, limit - 1), 'owned sheets') as { id: string; name: string }[]
      return rows
    },
    async sheetMeta(sheetId) {
      const rows = must(await db.from('sheets').select('id, name, owner_id').eq('id', sheetId).range(0, 0), 'sheet') as { id: string; name: string; owner_id: string }[]
      return rows[0] ? { id: rows[0].id, name: rows[0].name, ownerId: rows[0].owner_id } : null
    },
    async loadSheet(sheetId) {
      try {
        return await persistence.loadSheet(sheetId)
      } catch (err) {
        if (/0 rows|no rows|PGRST116/i.test((err as Error).message)) return null
        throw err
      }
    },
    async settings(sheetId) {
      const rows = must(await db.from('whatsapp_sheet_settings').select('*').eq('sheet_id', sheetId).range(0, 0), 'settings') as DbSettings[]
      return rows[0] ? settingsFromDb(rows[0]) : null
    },
    async enabledSettings() {
      const out: SheetSettings[] = []
      for (let from = 0; ; from += 1000) {
        const rows = must(await db.from('whatsapp_sheet_settings').select('*').eq('enabled', true).order('sheet_id').range(from, from + 999), 'enabled settings') as DbSettings[]
        out.push(...rows.map(settingsFromDb))
        if (rows.length < 1000) return out
      }
    },
    async patchCells(rowId, patch) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = must(await db.from('rows').select('cells, version').eq('id', rowId).range(0, 0), 'read row') as { cells: Record<string, unknown> | null; version: number }[]
        if (cur.length === 0) return { ok: false, error: 'The row no longer exists.' }
        const cells = { ...(cur[0].cells ?? {}), ...patch }
        const done = must(await db.from('rows').update({ cells, version: cur[0].version + 1 }).eq('id', rowId).eq('version', cur[0].version).select('id'), 'write row') as { id: string }[]
        if (done.length === 1) return { ok: true }
      }
      return { ok: false, error: 'The row was changed at the same time; try again.' }
    },
    async isRowLocked(rowId) {
      const rows = must(await db.from('row_locks').select('row_id').eq('row_id', rowId).range(0, 0), 'row lock') as unknown[]
      return rows.length > 0
    },

    async nudges(sheetId) {
      const rows = must(await db.from('whatsapp_nudges').select('*').eq('sheet_id', sheetId).range(0, 9999), 'nudges') as {
        row_id: string
        milestone: number
        phone: string
        sheet_id: string
        owner_id: string
        sent_count: number
        last_sent_at: string
        answered_at: string | null
        no_response_at: string | null
      }[]
      return rows.map((r) => ({
        rowId: r.row_id,
        milestone: r.milestone,
        phone: r.phone,
        sheetId: r.sheet_id,
        ownerId: r.owner_id,
        sentCount: r.sent_count,
        lastSentAt: Date.parse(r.last_sent_at),
        answeredAt: ms(r.answered_at),
        noResponseAt: ms(r.no_response_at),
      }))
    },
    async saveNudge(n) {
      must(
        await db.from('whatsapp_nudges').upsert(
          {
            row_id: n.rowId,
            milestone: n.milestone,
            phone: n.phone,
            sheet_id: n.sheetId,
            owner_id: n.ownerId,
            sent_count: n.sentCount,
            last_sent_at: iso(n.lastSentAt),
            answered_at: n.answeredAt === null ? null : iso(n.answeredAt),
            no_response_at: n.noResponseAt === null ? null : iso(n.noResponseAt),
          },
          { onConflict: 'row_id,milestone,phone' },
        ),
        'save nudge',
      )
    },
    async answerNudges(rowId, phone, at) {
      must(await db.from('whatsapp_nudges').update({ answered_at: iso(at) }).eq('row_id', rowId).eq('phone', phone).is('answered_at', null), 'answer nudges')
    },

    async pendingRuleMessages(nowMs, limit) {
      const rows = must(
        await db
          .from('notifications')
          .select('id, owner_id, sheet_id, row_id, recipient_email, title, body')
          .eq('channel', 'whatsapp')
          .eq('delivery_status', 'pending')
          .lte('deliver_after', iso(nowMs))
          .order('deliver_after')
          .range(0, limit - 1),
        'pending rule messages',
      ) as { id: string; owner_id: string; sheet_id: string | null; row_id: string | null; recipient_email: string; title: string; body: string }[]
      return rows.map((r) => ({ id: r.id, ownerId: r.owner_id, sheetId: r.sheet_id, rowId: r.row_id, email: r.recipient_email, title: r.title, body: r.body }))
    },
    async markRuleMessage(id, status, error, at) {
      must(await db.from('notifications').update({ delivery_status: status, delivery_error: error, delivered_at: iso(at) }).eq('id', id), 'mark rule message')
    },
    async notifyInApp(ownerId, n) {
      must(
        await db.from('notifications').insert({
          owner_id: ownerId,
          sheet_id: n.sheetId,
          row_id: n.rowId,
          channel: 'app',
          kind: 'system',
          title: n.title.slice(0, 200),
          body: n.body.slice(0, 4800),
          delivery_status: 'sent',
        }),
        'in-app notification',
      )
    },
    async account(userId) {
      const { data, error } = await db.auth.admin.getUserById(userId)
      if (error || !data.user) return null
      const u = data.user as { email?: string | null; is_anonymous?: boolean }
      return { email: u.email ? u.email.toLowerCase() : null, anonymous: u.is_anonymous === true || !u.email }
    },
  }
}
