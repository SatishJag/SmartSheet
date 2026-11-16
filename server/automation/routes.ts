/**
 * The automation HTTP routes.
 *
 *   GET  /api/automation/status      signed in   what this server can do
 *   POST /api/automation/requests    signed in   create update requests / approvals (links per recipient)
 *   GET  /api/u/:token               public      the update form: only the requested columns
 *   POST /api/u/:token               public      answer it (once)
 *   GET  /api/a/:token               public      the approval question
 *   POST /api/a/:token               public      approve / decline (once)
 *
 * The public routes are protected like the planner endpoints and then some: the token has 256 random
 * bits and only its sha256 is stored; anything that is not exactly a token is rejected before the
 * database; unknown, expired, used and revoked links give the same short answers and count towards a
 * per-address failure limit; requests are rate limited per address; bodies are small JSON only; every
 * response is `no-store` with no referrer and no indexing; and nothing but the requested columns ever
 * leaves the server.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Logger } from '../log'
import { clientIp, createLimiter, HttpError, readJsonBody, sendJson, type Limiter } from './http'
import type { Mailer } from './mailer'
import type { CreateInput, RequestService } from './requests'
import type { AutomationStore, RequestRecord } from './store'
import { hashToken, isTokenShape } from './tokens'

export interface AutomationRouteDeps {
  /** Verifies a Supabase access token; null when the server has no Supabase configuration. */
  authenticate: ((token: string) => Promise<{ userId: string } | null>) | null
  /** Null when SUPABASE_SERVICE_ROLE_KEY is missing: the features that need it answer 503. */
  store: AutomationStore | null
  requests: RequestService | null
  mailer: Mailer
  /** Why `store` is null, shown in the 503 message. */
  disabledReason?: string
  now?: () => number
  log: Logger
  /** The server runs behind one proxy (Railway): take the client address from X-Forwarded-For. */
  trustProxy?: boolean
  /** Limits (per address unless noted); the defaults suit one small instance. */
  limits?: { publicPerMinute?: number; failuresPer10Minutes?: number; createPerHourPerUser?: number }
}

const BODY_LIMIT = 16 * 1024
const MAX_TOKEN_CHARS = 8192

function bearer(req: IncomingMessage): string | null {
  const m = /^Bearer[ ]+([^\s]+)\s*$/i.exec(req.headers.authorization ?? '')
  return m && m[1].length <= MAX_TOKEN_CHARS ? m[1] : null
}

const GONE: Record<string, string> = {
  responded: 'This link has already been used.',
  approved: 'This request has already been answered.',
  declined: 'This request has already been answered.',
  expired: 'This link has expired.',
  revoked: 'This request was withdrawn.',
}

/** Returns a handler that answers the automation routes, or false for any other path. */
export function createAutomationRoutes(deps: AutomationRouteDeps) {
  const now = deps.now ?? Date.now
  const { log } = deps
  const lim = deps.limits ?? {}
  const perMinute: Limiter = createLimiter(lim.publicPerMinute ?? 60, 60_000, now)
  const failures: Limiter = createLimiter(lim.failuresPer10Minutes ?? 15, 10 * 60_000, now)
  const creates: Limiter = createLimiter(lim.createPerHourPerUser ?? 60, 3_600_000, now)

  async function user(req: IncomingMessage): Promise<{ userId: string }> {
    if (!deps.authenticate) throw new HttpError(503, 'The server is not configured for sign-in.')
    const token = bearer(req)
    if (!token) throw new HttpError(401, 'Sign in first (missing bearer token).', { 'WWW-Authenticate': 'Bearer' })
    let u: { userId: string } | null
    try {
      u = await deps.authenticate(token)
    } catch (err) {
      log('automation.auth.error', { error: (err as Error).message })
      throw new HttpError(503, 'Could not verify your session. Try again shortly.')
    }
    if (!u) throw new HttpError(401, 'Your session is invalid or has expired. Sign in again.', { 'WWW-Authenticate': 'Bearer' })
    return u
  }

  function needStore() {
    if (!deps.store || !deps.requests) throw new HttpError(503, deps.disabledReason ?? 'Update requests and approvals are off on this server.')
    return { store: deps.store, requests: deps.requests }
  }

  async function status(req: IncomingMessage, res: ServerResponse) {
    await user(req)
    sendJson(res, 200, { ok: true, enabled: deps.store !== null, mail: deps.mailer.kind })
  }

  async function createRequests(req: IncomingMessage, res: ServerResponse) {
    const { userId } = await user(req)
    const { store, requests } = needStore()
    if (!creates.hit(userId)) throw new HttpError(429, 'Too many requests sent this hour. Try again later.', { 'Retry-After': '600' })
    const input = parseCreate(await readJsonBody(req, BODY_LIMIT))
    if (typeof input === 'string') throw new HttpError(400, input)
    const sheetId = (input as { sheetId: string }).sheetId
    const bundle = await store.sheet(sheetId)
    // The caller must own the sheet. The same answer for "does not exist" and "not yours".
    if (!bundle || bundle.ownerId !== userId) throw new HttpError(404, 'That sheet was not found.')
    const result = await requests.create(bundle, input.create)
    if (!result.ok) throw new HttpError(result.status, result.error)
    log('automation.requests.created', { kind: input.create.kind, count: result.items.length })
    sendJson(res, 200, { ok: true, requests: result.items })
  }

  /** The record behind a token, or throws the HttpError for it. Unknown / unusable links count as failures. */
  async function lookup(kind: 'update' | 'approval', token: string, ip: string): Promise<RequestRecord> {
    const { store } = needStore()
    const fail = (status: number, message: string, extra: Record<string, unknown> = {}): never => {
      failures.hit(ip)
      throw Object.assign(new HttpError(status, message), { extra })
    }
    if (!isTokenShape(token)) return fail(404, 'This link is not valid.')
    const rec = await store.requestByHash(kind, hashToken(token))
    if (!rec) return fail(404, 'This link is not valid.')
    if (rec.status === 'pending' && now() > rec.expiresAt) {
      await store.expireRequest(kind, rec.id)
      return fail(410, GONE.expired, { state: 'expired' })
    }
    if (rec.status !== 'pending') return fail(410, GONE[rec.status] ?? 'This link can no longer be used.', { state: rec.status })
    return rec
  }

  async function publicRoute(kind: 'update' | 'approval', token: string, req: IncomingMessage, res: ServerResponse) {
    const ip = clientIp(req, deps.trustProxy === true)
    if (!perMinute.hit(ip) || failures.blocked(ip)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.', { 'Retry-After': '300' })
    const { store, requests } = needStore()
    const rec = await lookup(kind, token, ip)
    const bundle = await store.sheet(rec.sheetId)
    if (!bundle || !bundle.rows.some((r) => r.id === rec.rowId)) throw Object.assign(new HttpError(410, 'This row no longer exists.'), { extra: { state: 'gone' } })

    if (req.method === 'GET') return sendJson(res, 200, await requests.view(rec, bundle))

    const body = (await readJsonBody(req, BODY_LIMIT)) as Record<string, unknown> | null
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'The request body must be a JSON object.')
    const result = rec.kind === 'update' ? await requests.answerUpdate(rec, bundle, body.values) : await requests.answerApproval(rec, bundle, body.decision, body.comment)
    if (!result.ok) {
      if (result.status === 410) failures.hit(ip)
      throw Object.assign(new HttpError(result.status, result.error), { extra: { ...(result.fieldId ? { fieldId: result.fieldId } : {}), ...(result.state ? { state: result.state } : {}) } })
    }
    log('automation.request.answered', { kind })
    sendJson(res, 200, { ok: true })
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    let route: (() => Promise<void>) | null = null
    let method = 'GET'
    const m = /^\/api\/(u|a)\/([^/]+)$/.exec(pathname)
    if (pathname === '/api/automation/status') route = () => status(req, res)
    else if (pathname === '/api/automation/requests') {
      method = 'POST'
      route = () => createRequests(req, res)
    } else if (m) {
      method = 'GET|POST'
      let token = ''
      try {
        token = decodeURIComponent(m[2]).slice(0, 200)
      } catch {
        /* a malformed escape is just an invalid token */
      }
      route = () => publicRoute(m[1] === 'u' ? 'update' : 'approval', token, req, res)
    }
    if (!route) return false

    const allowed = method.split('|')
    if (!allowed.includes(req.method ?? '') && !(allowed.includes('GET') && req.method === 'HEAD')) {
      sendJson(res, 405, { ok: false, error: 'Method not allowed.' }, { Allow: allowed.join(', ') })
      return true
    }
    try {
      await route()
    } catch (err) {
      if (err instanceof HttpError) {
        const extra = (err as HttpError & { extra?: Record<string, unknown> }).extra ?? {}
        sendJson(res, err.status, { ok: false, error: err.message, ...extra }, err.headers)
      } else {
        log('automation.error', { path: m ? '/api/' + m[1] + '/:token' : pathname, error: (err as Error).message })
        sendJson(res, 500, { ok: false, error: 'Internal server error.' })
      }
    }
    return true
  }
}

type Parsed = { sheetId: string; create: CreateInput }

/** Validates the shape of POST /api/automation/requests; the rules about columns live in requests.ts. */
function parseCreate(body: unknown): Parsed | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'The request body must be a JSON object.'
  const b = body as Record<string, unknown>
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null)
  const strs = (v: unknown, maxItems: number) => (Array.isArray(v) && v.length <= maxItems && v.every((x) => typeof x === 'string' && x.length <= 320) ? (v as string[]) : null)
  const sheetId = str(b.sheetId, 64)
  const rowId = str(b.rowId, 64)
  const emails = strs(b.emails, 10)
  const message = b.message === undefined ? '' : str(b.message, 2000)
  if (!sheetId || !rowId) return 'sheetId and rowId are required.'
  if (!emails) return 'emails must be a list of at most 10 addresses.'
  if (message === null) return 'The message must be at most 2000 characters.'
  if (typeof b.expiresInDays !== 'number') return 'expiresInDays must be a number.'
  const ruleId = b.ruleId === null || b.ruleId === undefined ? null : str(b.ruleId, 64)
  if (b.kind === 'update') {
    const columnIds = strs(b.columnIds, 20)
    if (!columnIds) return 'columnIds must be a list of at most 20 columns.'
    return { sheetId, create: { kind: 'update', ruleId, rowId, emails, message, expiresInDays: b.expiresInDays, columnIds } }
  }
  if (b.kind === 'approval') {
    const a = b.approval as Record<string, unknown> | undefined
    if (typeof a !== 'object' || a === null) return 'approval settings are required.'
    const statusColumnId = str(a.statusColumnId, 64)
    const approvedValue = str(a.approvedValue, 200)
    const declinedValue = str(a.declinedValue, 200)
    const showColumnIds = a.showColumnIds === undefined ? [] : strs(a.showColumnIds, 50)
    const pendingValue = a.pendingValue === null || a.pendingValue === undefined ? null : str(a.pendingValue, 200)
    if (!statusColumnId || !approvedValue || !declinedValue || !showColumnIds || (a.pendingValue != null && pendingValue === null)) return 'approval settings are invalid.'
    return { sheetId, create: { kind: 'approval', ruleId, rowId, emails, message, expiresInDays: b.expiresInDays, approval: { statusColumnId, pendingValue, approvedValue, declinedValue, showColumnIds } } }
  }
  return 'kind must be "update" or "approval".'
}
