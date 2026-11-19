/**
 * The WhatsApp part of the in-memory fake backend (supabase/migrations/0015_whatsapp.sql), as far as
 * the browser uses it: `whatsapp_contacts`, `whatsapp_sheet_settings` and `whatsapp_messages`. Mirrors
 * the grants: a contact's status belongs to the server, the message log is read only. Links, codes,
 * sessions and opt-outs are server-only and not here. NOT a security test: src/db/whatsapp.test.ts runs
 * the real policies against PGlite.
 */
import type { DbRecord, FakeError } from './fakeSupabase'

export const WHATSAPP_TABLES = ['whatsapp_contacts', 'whatsapp_sheet_settings', 'whatsapp_messages'] as const
export type WhatsAppTable = (typeof WHATSAPP_TABLES)[number]
export const isWhatsAppTable = (t: string): t is WhatsAppTable => (WHATSAPP_TABLES as readonly string[]).includes(t)

interface ColumnSpec {
  default?: (ctx: { uid: string; now: () => string }) => unknown
  notNull?: boolean
}
const uuid = () => crypto.randomUUID()
const uid = ({ uid }: { uid: string }) => uid
const now = ({ now }: { now: () => string }) => now()
const nul = () => null

export const WHATSAPP_SCHEMA: Record<WhatsAppTable, Record<string, ColumnSpec>> = {
  whatsapp_contacts: {
    id: { default: uuid, notNull: true },
    owner_id: { default: uid, notNull: true },
    workspace_id: { default: uid, notNull: true },
    name: { notNull: true },
    email: { notNull: true },
    phone: { notNull: true },
    status: { default: () => 'invited', notNull: true },
    joined_at: { default: nul },
    created_at: { default: now, notNull: true },
  },
  // No `id`: the primary key is sheet_id.
  whatsapp_sheet_settings: {
    sheet_id: { notNull: true },
    owner_id: { default: uid, notNull: true },
    workspace_id: { default: uid, notNull: true },
    enabled: { default: () => true, notNull: true },
    delay_alerts: { default: () => true, notNull: true },
    nudges: { default: () => true, notNull: true },
    reminder_hours: { default: () => 24, notNull: true },
    max_reminders: { default: () => 2, notNull: true },
    daily_summary: { default: () => true, notNull: true },
    summary_hour: { default: () => 8, notNull: true },
    time_zone: { default: () => 'UTC', notNull: true },
    dnd_start: { default: () => '22:00', notNull: true },
    dnd_end: { default: () => '07:00', notNull: true },
    owner_column_id: { default: nul },
    updated_at: { default: now, notNull: true },
  },
  whatsapp_messages: {
    id: { default: uuid, notNull: true },
    owner_id: { default: nul },
    phone: { notNull: true },
    direction: { notNull: true },
    kind: { default: () => 'reply', notNull: true },
    priority: { default: () => 'MEDIUM', notNull: true },
    body: { notNull: true },
    sheet_id: { default: nul },
    row_id: { default: nul },
    status: { notNull: true },
    attempts: { default: () => 0, notNull: true },
    error: { default: nul },
    created_at: { default: now, notNull: true },
    sent_at: { default: nul },
  },
}

const denied = (table: string): FakeError => ({ message: `permission denied for table ${table}`, code: '42501' })

/** The browser's grants on these tables (null when allowed). */
export function whatsappAccessError(table: string, op: 'select' | 'insert' | 'upsert' | 'update' | 'delete', patch?: DbRecord, rows?: DbRecord[]): FakeError | null {
  if (table === 'whatsapp_messages' && op !== 'select') return denied(table)
  if (table === 'whatsapp_contacts') {
    const touchesServer = (r: DbRecord | undefined) => r !== undefined && ('status' in r || 'joined_at' in r || 'owner_id' in r)
    if (op === 'update' && touchesServer(patch)) return denied(table)
    if ((op === 'insert' || op === 'upsert') && rows?.some((r) => touchesServer(r))) return denied(table)
  }
  return null
}

/** Unique keys: one settings row per sheet; one contact per owner and e-mail, and per owner and phone. */
export function whatsappUniqueError(table: string, row: DbRecord, others: DbRecord[]): FakeError | null {
  const dup = (msg: string): FakeError => ({ message: `duplicate key value violates unique constraint "${msg}"`, code: '23505' })
  if (table === 'whatsapp_sheet_settings' && others.some((r) => r !== row && r.sheet_id === row.sheet_id)) return dup('whatsapp_sheet_settings_pkey')
  if (table === 'whatsapp_contacts') {
    if (others.some((r) => r !== row && r.owner_id === row.owner_id && r.email === row.email)) return dup('whatsapp_contacts_owner_id_email_key')
    if (others.some((r) => r !== row && r.owner_id === row.owner_id && r.phone === row.phone)) return dup('whatsapp_contacts_owner_id_phone_key')
  }
  return null
}

/** Rows of these tables that do not belong to a sheet (the fake otherwise requires an existing sheet). */
export const sheetless = (table: string, row: DbRecord) => (table === 'whatsapp_contacts' || table === 'whatsapp_messages') && row.sheet_id == null
