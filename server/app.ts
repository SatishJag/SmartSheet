/**
 * The planning server: health check, planner API and the built SPA. All dependencies are
 * injected so tests can run it on an ephemeral port with fakes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { BatchDraftResponse, CommittedProject, CommittedResponse, DraftResponse, HistorySource, ImportActivitiesResponse, ImportMappingResponse, PlannerOptions } from '../src/planner/types'
import { DEFAULT_MODEL, type AnthropicLike } from './ai'
import { DEFAULT_BATCH_CONCURRENCY, DEFAULT_BATCH_DEADLINE_MS, draftBatch as draftBatchItems } from './batch'
import { createDraftLimiter, type DraftLimits } from './limits'
import { consoleLogger, type Logger } from './log'
import { completeImport, mapImportColumns, parseImportRequest, prepareImport } from './importPlan'
import { createDraft, PlannerError } from './planner'
import { ProcoreError, type ProcoreClient } from './procore'
import { committedForProject, parseCommittedRequest } from './procoreSync'
import { parseBatchRequest, parsePlanRequest } from './request'
import { serveStatic } from './static'

/** A verified caller: who they are (for limits) and the history as they may read it. */
export interface AuthenticatedUser {
  userId: string
  history: HistorySource
}

/** Defaults for the AI draft limits (one server instance). */
export const DEFAULT_DRAFT_LIMITS: DraftLimits = { perUserPerHour: 10, perUserInFlight: 1, globalInFlight: 8, globalPerHour: 60 }

export interface AppDeps {
  /** Directory of the built SPA (vite build output). */
  staticDir: string
  /**
   * Verifies a Supabase access token. Returns the user's id and the history as that user sees it
   * (row-level security applies), or null when the token is invalid. Throws when verification
   * itself fails. Null when the server has no Supabase configuration: the planner API then answers 503.
   */
  authenticate: ((token: string) => Promise<AuthenticatedUser | null>) | null
  /**
   * Automation routes (server/automation): answers `/api/automation/*`, `/api/u/:token` and
   * `/api/a/:token`, returning false for any other path.
   */
  automation?: (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean>
  /** Limits on drafts; defaults to DEFAULT_DRAFT_LIMITS. */
  draftLimits?: DraftLimits
  /** Null when no API key is configured: drafts come from history only. */
  anthropic: AnthropicLike | null
  model?: string
  /** Per Anthropic API call. Default 120 s. */
  aiTimeoutMs?: number
  /** For a whole AI draft including the retry. Default 180 s. */
  aiDeadlineMs?: number
  /** Default 16 KiB. */
  maxBodyBytes?: number
  /** Items of one batch drafted at the same time. Default 2. */
  batchConcurrency?: number
  /** Time for a whole batch; items not started by then are drafted from history alone. Default 210 s. */
  batchDeadlineMs?: number
  log?: Logger
  /** Reads committed totals from Procore for the sync; null or absent when Procore is not configured (503). */
  procore?: ProcoreClient | null
}

/** Procore syncs: no AI is called, but each sync makes many Procore calls (rate-limited per company). */
const PROCORE_SYNC_LIMITS: DraftLimits = { perUserPerHour: 30, perUserInFlight: 1, globalInFlight: 4 }

const MAX_TOKEN_CHARS = 8192

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(text)
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, `The request body must be at most ${limit} bytes.`))
      req.resume()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, `The request body must be at most ${limit} bytes.`))
        req.removeAllListeners('data')
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function bearerToken(req: IncomingMessage): string | null {
  const m = /^Bearer[ ]+([^\s]+)\s*$/i.exec(req.headers.authorization ?? '')
  return m && m[1].length <= MAX_TOKEN_CHARS ? m[1] : null
}

export function createApp(deps: AppDeps): Server {
  const log = deps.log ?? consoleLogger
  const plannerConfig = {
    anthropic: deps.anthropic,
    model: deps.model ?? DEFAULT_MODEL,
    aiTimeoutMs: deps.aiTimeoutMs ?? 120_000,
    aiDeadlineMs: deps.aiDeadlineMs ?? 180_000,
    log,
  }
  const maxBody = deps.maxBodyBytes ?? 16 * 1024
  /** An imported plan (up to 500 activities) is larger than a draft request. */
  const importMaxBody = 1024 * 1024
  const limiter = createDraftLimiter(deps.draftLimits ?? DEFAULT_DRAFT_LIMITS)
  const procoreLimiter = createDraftLimiter(PROCORE_SYNC_LIMITS)

  /** The verified caller, or throws an HttpError (401/503). */
  async function authorize(req: IncomingMessage): Promise<AuthenticatedUser> {
    if (!deps.authenticate) throw new HttpError(503, 'The planner is not configured on this server.')
    const token = bearerToken(req)
    if (!token) throw new HttpError(401, 'Sign in to use the planner (missing bearer token).')
    let user: AuthenticatedUser | null
    try {
      user = await deps.authenticate(token)
    } catch (err) {
      log('auth.error', { error: (err as Error).message })
      throw new HttpError(503, 'Could not verify your session. Try again shortly.')
    }
    if (!user) throw new HttpError(401, 'Your session is invalid or has expired. Sign in again.')
    return user
  }

  async function options(req: IncomingMessage, res: ServerResponse) {
    const { history: source } = await authorize(req)
    try {
      json(res, 200, await source.options())
    } catch (err) {
      log('planner.options.error', { error: (err as Error).message })
      throw new HttpError(502, 'Could not read the planner history.')
    }
  }

  /** The request's JSON body, or throws an HttpError (415/413/400). */
  async function readJson(req: IncomingMessage, limit = maxBody): Promise<unknown> {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/json') throw new HttpError(415, 'Send the request as application/json.')
    try {
      return JSON.parse(await readBody(req, limit))
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new HttpError(400, 'The request body is not valid JSON.')
    }
  }

  /** One slot in flight per user for the whole request; every item counts against the hourly quotas. */
  function acquireSlot(userId: string, cost: number, event: string) {
    const slot = limiter.acquire(userId, cost)
    if (!slot.ok) {
      log(event, { status: slot.status, cost })
      throw new HttpError(slot.status, slot.message, { 'Retry-After': String(slot.retryAfterSeconds) })
    }
    return slot
  }

  async function draftBatch(req: IncomingMessage, res: ServerResponse) {
    const { userId, history: source } = await authorize(req)
    const parsed = parseBatchRequest(await readJson(req))
    if (!parsed.ok) throw new HttpError(400, parsed.error)
    const batch = parsed.value

    // A request-level mistake refuses the whole batch before anything is spent.
    let known: boolean
    try {
      known = (await source.options()).scheduleTypes.some((t) => t.id === batch.scheduleType)
    } catch (err) {
      log('planner.batch.error', { error: (err as Error).message })
      throw new HttpError(502, 'Could not read the planner history.')
    }
    if (!known) throw new HttpError(400, `Unknown schedule type: ${batch.scheduleType}.`)

    const slot = acquireSlot(userId, batch.items.length, 'planner.batch.limited')
    const disconnected = new AbortController()
    const onClose = () => {
      if (!res.writableFinished) disconnected.abort()
    }
    res.on('close', onClose)
    try {
      const { results, started } = await draftBatchItems(
        source,
        batch,
        { ...plannerConfig, signal: disconnected.signal },
        deps.batchConcurrency ?? DEFAULT_BATCH_CONCURRENCY,
        deps.batchDeadlineMs ?? DEFAULT_BATCH_DEADLINE_MS,
      )
      // Items never started (the client left) cost nothing.
      slot.refund(batch.items.length - started)
      if (disconnected.signal.aborted) {
        log('planner.batch.abandoned', { scheduleType: batch.scheduleType, items: batch.items.length, started })
        return
      }
      const done = results.map((r) => r ?? { ok: false as const, error: 'This item was not drafted.' })
      log('planner.batch', {
        scheduleType: batch.scheduleType,
        items: batch.items.length,
        failed: done.filter((r) => !r.ok).length,
      })
      const body: BatchDraftResponse = { ok: true, results: done }
      json(res, 200, body)
    } finally {
      res.off('close', onClose)
      slot.release()
    }
  }

  /**
   * Import a plan from Excel: map an unknown layout's columns, or match the schedule type and fill
   * blank durations. One hourly draft only when the AI is actually asked; always one slot in flight.
   */
  async function importPlan(req: IncomingMessage, res: ServerResponse) {
    const { userId, history: source } = await authorize(req)
    const parsed = parseImportRequest(await readJson(req, importMaxBody))
    if (!parsed.ok) throw new HttpError(400, parsed.error)
    const request = parsed.value
    const disconnected = new AbortController()
    const onClose = () => {
      if (!res.writableFinished) disconnected.abort()
    }
    res.on('close', onClose)
    const config = { ...plannerConfig, signal: disconnected.signal }
    try {
      if (request.columns) {
        const slot = acquireSlot(userId, plannerConfig.anthropic ? 1 : 0, 'planner.import.limited')
        try {
          const { mapping } = await mapImportColumns(request, config)
          log('planner.import.map', { sheets: request.columns.length, found: mapping !== null })
          json(res, 200, { ok: true, mapping } satisfies ImportMappingResponse)
        } finally {
          slot.release()
        }
        return
      }
      let prepared
      try {
        prepared = await prepareImport(source, request)
      } catch (err) {
        if (err instanceof PlannerError) throw new HttpError(err.status, err.message)
        log('planner.import.error', { error: (err as Error).message })
        throw new HttpError(502, 'Could not read the planner history.')
      }
      const needsAi = prepared.toEstimate.length > 0 && plannerConfig.anthropic !== null
      const slot = acquireSlot(userId, needsAi ? 1 : 0, 'planner.import.limited')
      try {
        const { value } = await completeImport(prepared, config)
        log('planner.import', { activities: request.activities?.length ?? 0, scheduleType: value.scheduleType, estimated: prepared.toEstimate.length })
        json(res, 200, { ok: true, ...value } satisfies ImportActivitiesResponse)
      } finally {
        slot.release()
      }
    } finally {
      res.off('close', onClose)
    }
  }

  async function draft(req: IncomingMessage, res: ServerResponse) {
    const { userId, history: source } = await authorize(req)
    const body = await readJson(req)
    const parsed = parsePlanRequest(body)
    if (!parsed.ok) throw new HttpError(400, parsed.error)

    const slot = acquireSlot(userId, 1, 'planner.draft.limited')
    // Stop paying for a draft nobody is waiting for: abort the AI call when the client goes away.
    const disconnected = new AbortController()
    const onClose = () => {
      if (!res.writableFinished) disconnected.abort()
    }
    res.on('close', onClose)
    try {
      const result: DraftResponse = {
        ok: true,
        draft: await createDraft(source, parsed.value, { ...plannerConfig, signal: disconnected.signal }),
      }
      if (disconnected.signal.aborted) {
        log('planner.draft.abandoned', { scheduleType: parsed.value.scheduleType })
        return
      }
      log('planner.draft', { scheduleType: parsed.value.scheduleType, source: result.draft.source })
      json(res, 200, result)
    } catch (err) {
      if (err instanceof PlannerError) throw new HttpError(err.status, err.message)
      log('planner.draft.error', { error: (err as Error).message })
      throw new HttpError(502, 'Could not read the planner history.')
    } finally {
      res.off('close', onClose)
      slot.release()
    }
  }

  /**
   * The Procore sync: committed totals per cost code for the sheet's projects. Only projects the caller
   * can read in `projects` and marked in Procore are looked up; a Procore failure fails the whole sync.
   */
  async function procoreCommitted(req: IncomingMessage, res: ServerResponse) {
    const { userId, history: source } = await authorize(req)
    const procore = deps.procore
    if (!procore) throw new HttpError(503, 'Procore is not set up on this server.')
    const parsed = parseCommittedRequest(await readJson(req))
    if (!parsed.ok) throw new HttpError(400, parsed.error)

    const slot = procoreLimiter.acquire(userId)
    if (!slot.ok) {
      log('procore.sync.limited', { status: slot.status })
      const message =
        slot.status === 503
          ? 'Too many Procore syncs are running. Try again in a moment.'
          : /already/.test(slot.message)
            ? 'A Procore sync is already running for you.'
            : `You have reached the limit of ${PROCORE_SYNC_LIMITS.perUserPerHour} Procore syncs per hour. Try again later.`
      throw new HttpError(slot.status, message, { 'Retry-After': String(slot.retryAfterSeconds) })
    }
    const disconnected = new AbortController()
    const onClose = () => {
      if (!res.writableFinished) disconnected.abort()
    }
    res.on('close', onClose)
    try {
      let options: PlannerOptions
      try {
        options = await source.options()
      } catch (err) {
        log('procore.sync.error', { error: (err as Error).message })
        throw new HttpError(502, 'Could not read the project list.')
      }
      const inProcore = new Set((options.projects ?? []).filter((p) => p.inProcore).map((p) => p.code))
      const projects: CommittedProject[] = []
      for (const p of parsed.value.projects) {
        if (!inProcore.has(p.code)) {
          projects.push({ code: p.code, status: 'not-in-procore' })
          continue
        }
        try {
          projects.push(await committedForProject(procore, p.code, p.costCodes, disconnected.signal))
        } catch (err) {
          if (disconnected.signal.aborted) return
          if (err instanceof ProcoreError) {
            log('procore.sync.failed', { project: p.code, error: err.message })
            throw new HttpError(502, `Could not sync with Procore: ${err.message}`)
          }
          throw err
        }
      }
      log('procore.sync', { projects: projects.length, synced: projects.filter((p) => p.status === 'ok').length })
      json(res, 200, { ok: true, projects } satisfies CommittedResponse)
    } finally {
      res.off('close', onClose)
      slot.release()
    }
  }

  const routes: Record<string, { method: string; handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void }> = {
    '/api/health': { method: 'GET', handle: (_req, res) => json(res, 200, { ok: true }) },
    '/api/planner/options': { method: 'GET', handle: options },
    '/api/planner/draft': { method: 'POST', handle: draft },
    '/api/planner/draft-batch': { method: 'POST', handle: draftBatch },
    '/api/planner/import': { method: 'POST', handle: importPlan },
    '/api/procore/committed': { method: 'POST', handle: procoreCommitted },
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      return json(res, 400, { ok: false, error: 'Bad request.' })
    }
    // Keep the raw path for static files: URL() resolves dot segments, which hides traversal attempts.
    const rawPath = req.url?.startsWith('/') ? req.url.split(/[?#]/)[0] : pathname

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      if (deps.automation && (await deps.automation(req, res, pathname))) return
      const route = routes[pathname]
      if (!route) return json(res, 404, { ok: false, error: 'Not found.' })
      if (req.method !== route.method && !(route.method === 'GET' && req.method === 'HEAD')) {
        return json(res, 405, { ok: false, error: 'Method not allowed.' }, { Allow: route.method })
      }
      try {
        await route.handle(req, res)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500
        if (!(err instanceof HttpError)) log('server.error', { path: pathname, error: (err as Error).message })
        const message = err instanceof HttpError ? err.message : 'Internal server error.'
        const headers: Record<string, string> = { ...(err instanceof HttpError ? err.headers : {}) }
        if (status === 401) headers['WWW-Authenticate'] = 'Bearer'
        if (status === 413) headers.Connection = 'close'
        json(res, status, { ok: false, error: message }, headers)
      }
      return
    }
    return serveStatic(req, res, deps.staticDir, rawPath)
  }

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log('server.error', { error: (err as Error).message })
      if (!res.headersSent) json(res, 500, { ok: false, error: 'Internal server error.' })
      else res.destroy()
    })
  })
}
