/**
 * A read-only Procore REST client for the Procore sync (docs/superpowers/specs/2026-11-22-procore-sync-design.md):
 * client-credentials sign-in (token kept until shortly before it expires), paginated GETs, one wait on a
 * rate limit. Only `POST /oauth/token` and GETs are ever sent. The secret and tokens never appear in an
 * error message or a log.
 */

export interface ProcoreConfig {
  clientId: string
  clientSecret: string
  companyId: string
  loginHost: string
  apiHost: string
}

const HOSTS: Record<string, { loginHost: string; apiHost: string }> = {
  sandbox: { loginHost: 'https://login-sandbox.procore.com', apiHost: 'https://sandbox.procore.com' },
  production: { loginHost: 'https://login.procore.com', apiHost: 'https://api.procore.com' },
}

/** The Procore settings from the environment, or the names of those missing or invalid. */
export function procoreConfigFromEnv(env: Record<string, string | undefined>): { config: ProcoreConfig } | { missing: string[] } {
  const get = (name: string) => env[name]?.trim() ?? ''
  const values = {
    PROCORE_CLIENT_ID: get('PROCORE_CLIENT_ID'),
    PROCORE_CLIENT_SECRET: get('PROCORE_CLIENT_SECRET'),
    PROCORE_COMPANY_ID: get('PROCORE_COMPANY_ID'),
    PROCORE_ENV: get('PROCORE_ENV'),
  }
  const hosts = HOSTS[values.PROCORE_ENV.toLowerCase()]
  const missing = Object.entries(values)
    .filter(([name, value]) => value === '' || (name === 'PROCORE_ENV' && !hosts))
    .map(([name]) => name)
  if (missing.length > 0) return { missing }
  return { config: { clientId: values.PROCORE_CLIENT_ID, clientSecret: values.PROCORE_CLIENT_SECRET, companyId: values.PROCORE_COMPANY_ID, ...hosts } }
}

/** A Procore failure, with a message fit to show the user. */
export class ProcoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProcoreError'
  }
}

export interface ProcoreClient {
  readonly companyId: string
  /** Every item of a paginated list endpoint (array body), following Link rel="next". */
  getAll<T>(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<T[]>
  /** One object (e.g. a project), with the same sign-in, retries and timeout. */
  get<T>(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<T>
}

export interface ProcoreClientDeps {
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Per call. Default 15 s. */
  timeoutMs?: number
}

const PER_PAGE = 100
const MAX_PAGES = 50
/** A token is renewed this long before Procore says it expires. */
const EXPIRY_MARGIN_MS = 60_000
/** The longest wait on a rate limit before giving up. */
const MAX_WAIT_MS = 10_000

const REFUSED = 'Procore refused the app’s credentials.'
const BUSY = 'Procore is busy; try again in a minute.'
const UNREACHABLE = 'Could not reach Procore.'
const UNEXPECTED = 'Procore sent an unexpected response.'

const isAbort = (err: unknown) => err instanceof Error && err.name === 'AbortError'

export function createProcoreClient(config: ProcoreConfig, deps: ProcoreClientDeps = {}): ProcoreClient {
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const timeoutMs = deps.timeoutMs ?? 15_000
  let token: { value: string; renewAt: number } | null = null

  /** fetch with a timeout; network failures and timeouts become ProcoreError, the caller's abort stays an AbortError. */
  async function send(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      return await doFetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    } catch (err) {
      if (signal?.aborted && isAbort(signal.reason)) throw signal.reason
      if (signal?.aborted) throw err
      throw new ProcoreError(UNREACHABLE)
    }
  }

  async function accessToken(signal?: AbortSignal): Promise<string> {
    if (token && now() < token.renewAt) return token.value
    const res = await send(
      `${config.loginHost}/oauth/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret }).toString(),
      },
      signal,
    )
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new ProcoreError(REFUSED)
    if (!res.ok) throw new ProcoreError(`Procore answered ${res.status}.`)
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null
    if (!body || typeof body.access_token !== 'string' || body.access_token === '') throw new ProcoreError(UNEXPECTED)
    const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 0
    token = { value: body.access_token, renewAt: now() + expiresIn * 1000 - EXPIRY_MARGIN_MS }
    return token.value
  }

  /** How long to wait before retrying a 429/503, or null when there is nothing to wait for (or too long). */
  function waitFor(res: Response): number | null {
    const reset = Number(res.headers.get('X-Rate-Limit-Reset'))
    const retryAfter = Number(res.headers.get('Retry-After'))
    const ms = res.headers.get('X-Rate-Limit-Reset') && Number.isFinite(reset) ? reset * 1000 - now() : res.headers.get('Retry-After') && Number.isFinite(retryAfter) ? retryAfter * 1000 : null
    if (ms === null || ms > MAX_WAIT_MS) return null
    return Math.max(0, Math.ceil(ms))
  }

  /** One GET, with one fresh sign-in on 401 and one wait on a rate limit. */
  async function request(url: string, signal?: AbortSignal): Promise<Response> {
    let renewed = false
    let waited = false
    for (;;) {
      const res = await send(url, { method: 'GET', headers: { Authorization: `Bearer ${await accessToken(signal)}`, 'Procore-Company-Id': config.companyId, Accept: 'application/json' } }, signal)
      if (res.status === 401) {
        if (renewed) throw new ProcoreError(REFUSED)
        renewed = true
        token = null
        continue
      }
      if (res.status === 429 || res.status === 503) {
        const ms = waited ? null : waitFor(res)
        if (ms === null) throw new ProcoreError(BUSY)
        waited = true
        await sleep(ms)
        continue
      }
      if (!res.ok) throw new ProcoreError(`Procore answered ${res.status}.`)
      return res
    }
  }

  return {
    companyId: config.companyId,
    async getAll<T>(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<T[]> {
      const items: T[] = []
      for (let page = 1; page <= MAX_PAGES; page++) {
        const params = new URLSearchParams({ ...query, page: String(page), per_page: String(PER_PAGE) })
        const res = await request(`${config.apiHost}${path}?${params.toString()}`, signal)
        const body: unknown = await res.json().catch(() => null)
        if (!Array.isArray(body)) throw new ProcoreError(UNEXPECTED)
        items.push(...(body as T[]))
        if (!/rel="?next"?/.test(res.headers.get('Link') ?? '')) return items
      }
      throw new ProcoreError(`Procore returned more than ${MAX_PAGES} pages; the sync stops there.`)
    },
    async get<T>(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<T> {
      const params = new URLSearchParams(query).toString()
      const res = await request(`${config.apiHost}${path}${params ? `?${params}` : ''}`, signal)
      const body: unknown = await res.json().catch(() => null)
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ProcoreError(UNEXPECTED)
      return body as T
    },
  }
}
