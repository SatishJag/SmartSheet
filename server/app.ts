/**
 * The planning server: health check, planner API and the built SPA. All dependencies are
 * injected so tests can run it on an ephemeral port with fakes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { DraftResponse, HistorySource } from '../src/planner/types'
import { DEFAULT_MODEL, type AnthropicLike } from './ai'
import { consoleLogger, type Logger } from './log'
import { createDraft, PlannerError } from './planner'
import { parsePlanRequest } from './request'
import { serveStatic } from './static'

export interface AppDeps {
  /** Directory of the built SPA (vite build output). */
  staticDir: string
  /**
   * Verifies a Supabase access token. Returns the history as that user sees it (row-level
   * security applies), or null when the token is invalid. Throws when verification itself fails.
   * Null when the server has no Supabase configuration: the planner API then answers 503.
   */
  authenticate: ((token: string) => Promise<HistorySource | null>) | null
  /** Null when no API key is configured: drafts come from history only. */
  anthropic: AnthropicLike | null
  model?: string
  /** Per Anthropic API call. Default 120 s. */
  aiTimeoutMs?: number
  /** For a whole AI draft including the retry. Default 180 s. */
  aiDeadlineMs?: number
  /** Default 16 KiB. */
  maxBodyBytes?: number
  log?: Logger
}

const MAX_TOKEN_CHARS = 8192

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
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

  /** The caller's history source, or throws an HttpError (401/503). */
  async function authorize(req: IncomingMessage): Promise<HistorySource> {
    if (!deps.authenticate) throw new HttpError(503, 'The planner is not configured on this server.')
    const token = bearerToken(req)
    if (!token) throw new HttpError(401, 'Sign in to use the planner (missing bearer token).')
    let source: HistorySource | null
    try {
      source = await deps.authenticate(token)
    } catch (err) {
      log('auth.error', { error: (err as Error).message })
      throw new HttpError(503, 'Could not verify your session. Try again shortly.')
    }
    if (!source) throw new HttpError(401, 'Your session is invalid or has expired. Sign in again.')
    return source
  }

  async function options(req: IncomingMessage, res: ServerResponse) {
    const source = await authorize(req)
    try {
      json(res, 200, await source.options())
    } catch (err) {
      log('planner.options.error', { error: (err as Error).message })
      throw new HttpError(502, 'Could not read the planner history.')
    }
  }

  async function draft(req: IncomingMessage, res: ServerResponse) {
    const source = await authorize(req)
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/json') throw new HttpError(415, 'Send the request as application/json.')
    let body: unknown
    try {
      body = JSON.parse(await readBody(req, maxBody))
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new HttpError(400, 'The request body is not valid JSON.')
    }
    const parsed = parsePlanRequest(body)
    if (!parsed.ok) throw new HttpError(400, parsed.error)
    try {
      const result: DraftResponse = { ok: true, draft: await createDraft(source, parsed.value, plannerConfig) }
      log('planner.draft', { scheduleType: parsed.value.scheduleType, source: result.draft.source })
      json(res, 200, result)
    } catch (err) {
      if (err instanceof PlannerError) throw new HttpError(err.status, err.message)
      log('planner.draft.error', { error: (err as Error).message })
      throw new HttpError(502, 'Could not read the planner history.')
    }
  }

  const routes: Record<string, { method: string; handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void }> = {
    '/api/health': { method: 'GET', handle: (_req, res) => json(res, 200, { ok: true }) },
    '/api/planner/options': { method: 'GET', handle: options },
    '/api/planner/draft': { method: 'POST', handle: draft },
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
        const headers: Record<string, string> = status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}
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
