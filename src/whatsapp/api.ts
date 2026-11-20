/**
 * The WhatsApp page's data: the caller's own rows through Supabase (row-level security applies) and
 * the planning server's /api/whatsapp/* endpoints (contract: server/whatsapp/routes.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { columnFromDb, type DbColumn } from '../store/persistence'
import type { Column } from '../model/validate'

export interface WaStatus {
  enabled: boolean
  reason: string | null
  mode: 'meta' | 'simulator'
  businessNumber: string | null
  template: boolean
  ai: boolean
  linked: { phone: string; masked: string } | null
}

export interface WaContact {
  id: string
  name: string
  email: string
  phone: string
  status: 'invited' | 'active'
  createdAt: string
}

export interface WaSettings {
  sheetId: string
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

export interface WaMessage {
  id: string
  phone: string
  direction: 'in' | 'out'
  kind: string
  priority: string
  body: string
  sheetId: string | null
  status: string
  error: string | null
  createdAt: string
}

export type ServerResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string }

export function defaultSettings(sheetId: string): WaSettings {
  let tz = 'UTC'
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    /* keep UTC */
  }
  return { sheetId, enabled: true, delayAlerts: true, nudges: true, reminderHours: 24, maxReminders: 2, dailySummary: true, summaryHour: 8, timeZone: tz, dndStart: '22:00', dndEnd: '07:00', ownerColumnId: null }
}

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data
}

export function whatsappApi(client: SupabaseClient) {
  async function server<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<ServerResult<T>> {
    const { data } = await client.auth.getSession()
    const token = data.session?.access_token
    if (!token) return { ok: false, status: 401, error: 'You are signed out.' }
    try {
      const res = await fetch(path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      let json: unknown = null
      try {
        json = await res.json()
      } catch {
        /* not JSON */
      }
      if (!res.ok) return { ok: false, status: res.status, error: (json as { error?: string } | null)?.error ?? `The server answered ${res.status}.` }
      return { ok: true, data: json as T }
    } catch {
      return { ok: false, status: 0, error: 'The planning server could not be reached.' }
    }
  }

  return {
    status: () => server<WaStatus>('/api/whatsapp/status', 'GET'),
    linkCode: () => server<{ code: string; text: string; waLink: string | null; expiresAt: string }>('/api/whatsapp/link', 'POST'),
    invite: (contactId: string) => server<{ code: string; text: string; waLink: string | null; message: string; expiresAt: string }>(`/api/whatsapp/contacts/${contactId}/invite`, 'POST'),
    summaryNow: (sheetId: string) => server<{ ok: boolean }>(`/api/whatsapp/sheets/${sheetId}/summary`, 'POST'),
    checkNow: (sheetId: string) => server<{ alerts: number; nudges: number; summary: boolean }>(`/api/whatsapp/sheets/${sheetId}/check`, 'POST'),
    simulate: (text: string, phone?: string) => server<{ phone: string; replies: { body: string; status: string }[] }>('/api/whatsapp/simulate', 'POST', { text, ...(phone ? { phone } : {}) }),

    unlink: () => server<{ ok: true }>('/api/whatsapp/unlink', 'POST'),

    async listSheets(): Promise<{ id: string; name: string }[]> {
      return check(await client.from('sheets').select('id, name').order('name').order('id').range(0, 999)) as { id: string; name: string }[]
    },
    async listColumns(sheetId: string): Promise<Column[]> {
      const rows = check(await client.from('columns').select('*').eq('sheet_id', sheetId).order('position').order('id').range(0, 999)) as DbColumn[]
      return rows.map(columnFromDb)
    },

    async getSettings(sheetId: string): Promise<WaSettings | null> {
      const rows = check(await client.from('whatsapp_sheet_settings').select('*').eq('sheet_id', sheetId).range(0, 0)) as Record<string, unknown>[]
      const r = rows[0]
      if (!r) return null
      return {
        sheetId,
        enabled: r.enabled as boolean,
        delayAlerts: r.delay_alerts as boolean,
        nudges: r.nudges as boolean,
        reminderHours: r.reminder_hours as number,
        maxReminders: r.max_reminders as number,
        dailySummary: r.daily_summary as boolean,
        summaryHour: r.summary_hour as number,
        timeZone: r.time_zone as string,
        dndStart: r.dnd_start as string,
        dndEnd: r.dnd_end as string,
        ownerColumnId: (r.owner_column_id as string | null) ?? null,
      }
    },
    /** Update, else insert (one row per sheet). */
    async saveSettings(s: WaSettings): Promise<void> {
      const values = {
        enabled: s.enabled,
        delay_alerts: s.delayAlerts,
        nudges: s.nudges,
        reminder_hours: s.reminderHours,
        max_reminders: s.maxReminders,
        daily_summary: s.dailySummary,
        summary_hour: s.summaryHour,
        time_zone: s.timeZone,
        dnd_start: s.dndStart,
        dnd_end: s.dndEnd,
        owner_column_id: s.ownerColumnId,
        updated_at: new Date().toISOString(),
      }
      const updated = check(await client.from('whatsapp_sheet_settings').update(values).eq('sheet_id', s.sheetId).select('sheet_id')) as unknown[]
      if (updated.length === 0) check(await client.from('whatsapp_sheet_settings').insert({ sheet_id: s.sheetId, ...values }))
    },

    async listContacts(): Promise<WaContact[]> {
      const rows = check(await client.from('whatsapp_contacts').select('id, name, email, phone, status, created_at').order('name').order('id').range(0, 999)) as {
        id: string
        name: string
        email: string
        phone: string
        status: 'invited' | 'active'
        created_at: string
      }[]
      return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone, status: r.status, createdAt: r.created_at }))
    },
    async addContact(c: { name: string; email: string; phone: string }): Promise<void> {
      check(await client.from('whatsapp_contacts').insert({ name: c.name.trim(), email: c.email.trim().toLowerCase(), phone: c.phone }))
    },
    async updateContact(id: string, c: { name: string; email: string; phone: string }): Promise<void> {
      check(await client.from('whatsapp_contacts').update({ name: c.name.trim(), email: c.email.trim().toLowerCase(), phone: c.phone }).eq('id', id))
    },
    async deleteContact(id: string): Promise<void> {
      check(await client.from('whatsapp_contacts').delete().eq('id', id))
    },

    async listMessages(limit = 100): Promise<WaMessage[]> {
      const rows = check(
        await client.from('whatsapp_messages').select('id, phone, direction, kind, priority, body, sheet_id, status, error, created_at').order('created_at', { ascending: false }).range(0, limit - 1),
      ) as { id: string; phone: string; direction: 'in' | 'out'; kind: string; priority: string; body: string; sheet_id: string | null; status: string; error: string | null; created_at: string }[]
      return rows.map((r) => ({ id: r.id, phone: r.phone, direction: r.direction, kind: r.kind, priority: r.priority, body: r.body, sheetId: r.sheet_id, status: r.status, error: r.error, createdAt: r.created_at }))
    },
  }
}

export type WhatsAppApi = ReturnType<typeof whatsappApi>
