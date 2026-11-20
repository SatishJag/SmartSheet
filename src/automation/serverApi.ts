/**
 * Calls to the planning server's automation endpoints (signed in with the user's access token).
 * Contract: server/automation/routes.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { StepResult } from './execute'
import type { PlannedAction } from './types'

export interface AutomationStatus {
  /** The server has what it needs for time based rules, update requests and approvals. */
  enabled: boolean
  /** How e-mail leaves the server. */
  mail: 'resend' | 'simulator'
}

async function token(client: SupabaseClient): Promise<string | null> {
  const { data } = await client.auth.getSession()
  return data.session?.access_token ?? null
}

async function call<T>(client: SupabaseClient, path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<{ status: number; body: T | { ok: false; error: string } }> {
  const t = await token(client)
  if (!t) return { status: 401, body: { ok: false, error: 'You are signed out.' } }
  try {
    const res = await fetch(path, {
      method: init.method,
      headers: { Authorization: `Bearer ${t}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    })
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = { ok: false, error: `The server answered ${res.status}.` }
    }
    return { status: res.status, body: body as T }
  } catch {
    return { status: 0, body: { ok: false, error: 'The server could not be reached.' } }
  }
}

/** What the server can do, or null when it cannot be reached (static hosting, dev without the server). */
export async function fetchStatus(client: SupabaseClient): Promise<AutomationStatus | null> {
  const res = await call<AutomationStatus & { ok: true }>(client, '/api/automation/status', { method: 'GET' })
  return res.status === 200 && 'enabled' in res.body ? { enabled: res.body.enabled, mail: res.body.mail } : null
}

export interface RequestBody {
  kind: 'update' | 'approval'
  ruleId: string | null
  sheetId: string
  rowId: string
  emails: string[]
  message: string
  expiresInDays: number
  columnIds?: string[]
  approval?: { statusColumnId: string; pendingValue: string | null; approvedValue: string; declinedValue: string; showColumnIds: string[] }
}

export async function sendRequest(client: SupabaseClient, body: RequestBody): Promise<StepResult> {
  const res = await call<{ ok: true }>(client, '/api/automation/requests', { method: 'POST', body })
  if (res.status === 200 && res.body.ok) return { ok: true }
  const error = 'error' in res.body ? res.body.error : 'The request was not sent.'
  return { ok: false, error: res.status === 503 ? `Update requests and approvals need the server: ${error}` : error }
}

export function requestBodyFor(
  a: Extract<PlannedAction, { type: 'update_request' | 'approval' }>,
  ruleId: string | null,
  sheetId: string,
): RequestBody {
  return a.type === 'update_request'
    ? { kind: 'update', ruleId, sheetId, rowId: a.rowId, emails: a.emails, message: a.message, expiresInDays: a.expiresInDays, columnIds: a.columnIds }
    : {
        kind: 'approval',
        ruleId,
        sheetId,
        rowId: a.rowId,
        emails: a.emails,
        message: a.message,
        expiresInDays: a.expiresInDays,
        approval: { statusColumnId: a.statusColumnId, pendingValue: a.pendingValue, approvedValue: a.approvedValue, declinedValue: a.declinedValue, showColumnIds: a.showColumnIds },
      }
}
