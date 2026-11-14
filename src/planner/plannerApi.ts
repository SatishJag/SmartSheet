import type { SupabaseClient } from '@supabase/supabase-js'
import type { DraftResponse, PlanDraft, PlannerOptions, PlanRequest } from './types'

/**
 * Client for the planning server (same origin, `/api/planner/...`). Every call carries the user's
 * Supabase access token; the server verifies it and reads history with it, so row-level security
 * applies. Failures are thrown as PlannerApiError with a message fit to show the planner.
 */

export type PlannerErrorKind =
  /** 401, or no session: the user must sign in again. */
  | 'session'
  /** Any other 4xx: the server refused the request and said why. */
  | 'request'
  /** 5xx, or a 200 that says ok: false. */
  | 'server'
  /** fetch itself failed: offline, DNS, server down. */
  | 'network'
  /** A reply that is not what the contract promises (e.g. the SPA's HTML instead of JSON). */
  | 'response'

export class PlannerApiError extends Error {
  readonly kind: PlannerErrorKind
  readonly status: number | null
  constructor(message: string, kind: PlannerErrorKind, status: number | null = null) {
    super(message)
    this.name = 'PlannerApiError'
    this.kind = kind
    this.status = status
  }
}

export const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Sign in again to use the planner.'
const NETWORK_MESSAGE = 'Could not reach the planning server. Check your connection and try again.'
const UNEXPECTED_MESSAGE = 'The planning server sent an unexpected response. Try again in a moment.'

/** The signed-in user's access token, from the Supabase auth session. */
export async function getAccessToken(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.getSession()
  const token = data.session?.access_token
  if (error || !token) throw new PlannerApiError(SESSION_EXPIRED_MESSAGE, 'session', null)
  return token
}

export interface CallOptions {
  signal?: AbortSignal
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The `error` (or `message`) string of a JSON error body, if any. */
function serverMessage(body: unknown): string | null {
  if (!isObject(body)) return null
  const m = body.error ?? body.message
  return typeof m === 'string' && m.trim() !== '' ? m.trim() : null
}

async function call(path: string, token: string, init: RequestInit, opts: CallOptions): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`/api/planner/${path}`, {
      ...init,
      signal: opts.signal,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new PlannerApiError(NETWORK_MESSAGE, 'network')
  }
  let body: unknown = null
  try {
    const text = await res.text()
    body = text === '' ? null : JSON.parse(text)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    body = undefined // not JSON
  }
  if (res.status === 401) throw new PlannerApiError(SESSION_EXPIRED_MESSAGE, 'session', 401)
  if (res.status >= 400 && res.status < 500) {
    throw new PlannerApiError(serverMessage(body) ?? `The planner could not handle the request (${res.status}).`, 'request', res.status)
  }
  if (!res.ok) {
    const m = serverMessage(body)
    throw new PlannerApiError(
      m ? `The planning server failed: ${m}` : `The planning server is unavailable (${res.status}). Try again in a moment.`,
      'server',
      res.status,
    )
  }
  if (body === undefined || body === null) throw new PlannerApiError(UNEXPECTED_MESSAGE, 'response', res.status)
  return body
}

function isOptions(v: unknown): v is PlannerOptions {
  return (
    isObject(v) &&
    Array.isArray(v.scheduleTypes) &&
    v.scheduleTypes.every((t) => isObject(t) && typeof t.id === 'string' && typeof t.name === 'string') &&
    isObject(v.equipmentTypes) &&
    Object.values(v.equipmentTypes).every((list) => Array.isArray(list) && list.every((x) => typeof x === 'string'))
  )
}

function isDraft(v: unknown): v is PlanDraft {
  return (
    isObject(v) &&
    isObject(v.request) &&
    Array.isArray(v.activities) &&
    Array.isArray(v.links) &&
    typeof v.targetCode === 'string' &&
    isObject(v.history) &&
    Array.isArray(v.assumptions) &&
    Array.isArray(v.risks)
  )
}

/** GET /api/planner/options: schedule types and equipment types with history. */
export async function getOptions(token: string, opts: CallOptions = {}): Promise<PlannerOptions> {
  const body = await call('options', token, { method: 'GET' }, opts)
  if (!isOptions(body)) throw new PlannerApiError(UNEXPECTED_MESSAGE, 'response', 200)
  return body
}

/** POST /api/planner/draft: a first-cut plan (no dates) for the request. */
export async function requestDraft(token: string, request: PlanRequest, opts: CallOptions = {}): Promise<PlanDraft> {
  const body = (await call(
    'draft',
    token,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) },
    opts,
  )) as DraftResponse | unknown
  if (isObject(body) && body.ok === false) {
    throw new PlannerApiError(serverMessage(body) ?? 'The planner could not draft a plan.', 'server', 200)
  }
  if (!isObject(body) || body.ok !== true || !isDraft(body.draft)) {
    throw new PlannerApiError(UNEXPECTED_MESSAGE, 'response', 200)
  }
  return body.draft
}
