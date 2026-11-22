// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createProcoreClient, procoreConfigFromEnv, ProcoreError, type ProcoreConfig } from './procore'

const SECRET = 's3cret-value'
const CONFIG: ProcoreConfig = {
  clientId: 'cid',
  clientSecret: SECRET,
  companyId: '42',
  loginHost: 'https://login-sandbox.procore.com',
  apiHost: 'https://sandbox.procore.com',
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

/** A fake fetch: token requests get t1, t2, … unless `token` says otherwise; API requests go to `api`. */
function fakeProcore(api: Handler, token?: Handler) {
  const calls: { url: URL; init: RequestInit }[] = []
  let issued = 0
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    if (url.pathname === '/oauth/token') {
      if (token) return token(url, init)
      issued++
      return Response.json({ access_token: `t${issued}`, token_type: 'bearer', expires_in: 5400, created_at: 0 })
    }
    return api(url, init)
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls, tokenCalls: () => calls.filter((c) => c.url.pathname === '/oauth/token'), apiCalls: () => calls.filter((c) => c.url.pathname !== '/oauth/token') }
}

const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name)

describe('procoreConfigFromEnv', () => {
  const ENV = { PROCORE_CLIENT_ID: ' cid ', PROCORE_CLIENT_SECRET: 'sec', PROCORE_COMPANY_ID: '42 ', PROCORE_ENV: 'sandbox' }

  it('reads config from env', () => {
    expect(procoreConfigFromEnv(ENV)).toEqual({
      config: { clientId: 'cid', clientSecret: 'sec', companyId: '42', loginHost: 'https://login-sandbox.procore.com', apiHost: 'https://sandbox.procore.com' },
    })
    expect(procoreConfigFromEnv({ ...ENV, PROCORE_ENV: 'production' })).toEqual({
      config: { clientId: 'cid', clientSecret: 'sec', companyId: '42', loginHost: 'https://login.procore.com', apiHost: 'https://api.procore.com' },
    })
  })

  it('names what is missing or invalid', () => {
    expect(procoreConfigFromEnv({ ...ENV, PROCORE_CLIENT_SECRET: '  ', PROCORE_COMPANY_ID: undefined })).toEqual({ missing: ['PROCORE_CLIENT_SECRET', 'PROCORE_COMPANY_ID'] })
    expect(procoreConfigFromEnv({ ...ENV, PROCORE_ENV: 'staging' })).toEqual({ missing: ['PROCORE_ENV'] })
    expect(procoreConfigFromEnv({})).toEqual({ missing: ['PROCORE_CLIENT_ID', 'PROCORE_CLIENT_SECRET', 'PROCORE_COMPANY_ID', 'PROCORE_ENV'] })
  })
})

describe('createProcoreClient', () => {
  it('signs in once and reuses the token', async () => {
    const p = fakeProcore(() => Response.json([{ id: 1 }]))
    const client = createProcoreClient(CONFIG, { fetch: p.fetch })
    expect(client.companyId).toBe('42')
    expect(await client.getAll('/rest/v1.0/things', { project_id: '7' })).toEqual([{ id: 1 }])
    await client.getAll('/rest/v1.0/things', { project_id: '7' })
    expect(p.tokenCalls()).toHaveLength(1)
    const tokenCall = p.tokenCalls()[0]
    expect(tokenCall.url.origin).toBe('https://login-sandbox.procore.com')
    expect(tokenCall.init.method).toBe('POST')
    expect(Object.fromEntries(new URLSearchParams(String(tokenCall.init.body)))).toEqual({ grant_type: 'client_credentials', client_id: 'cid', client_secret: SECRET })
    const apiCall = p.apiCalls()[0]
    expect(apiCall.url.origin).toBe('https://sandbox.procore.com')
    expect(apiCall.url.searchParams.get('project_id')).toBe('7')
    expect(header(apiCall.init, 'Authorization')).toBe('Bearer t1')
    expect(header(apiCall.init, 'Procore-Company-Id')).toBe('42')
  })

  it('signs in again when the token is about to expire', async () => {
    let t = 1_000_000
    const p = fakeProcore(() => Response.json([]))
    const client = createProcoreClient(CONFIG, { fetch: p.fetch, now: () => t })
    await client.getAll('/x', {})
    t += 5339_000
    await client.getAll('/x', {})
    expect(p.tokenCalls()).toHaveLength(1)
    t += 2_000 // now 5341 s after sign-in: within 60 s of expiry
    await client.getAll('/x', {})
    expect(p.tokenCalls()).toHaveLength(2)
    expect(header(p.apiCalls()[2].init, 'Authorization')).toBe('Bearer t2')
  })

  it('retries once with a new token on 401', async () => {
    let n = 0
    const p = fakeProcore(() => (++n === 1 ? new Response('', { status: 401 }) : Response.json([{ ok: 1 }])))
    const client = createProcoreClient(CONFIG, { fetch: p.fetch })
    expect(await client.getAll('/x', {})).toEqual([{ ok: 1 }])
    expect(p.tokenCalls()).toHaveLength(2)

    const always = fakeProcore(() => new Response('', { status: 401 }))
    await expect(createProcoreClient(CONFIG, { fetch: always.fetch }).getAll('/x', {})).rejects.toEqual(new ProcoreError('Procore refused the app’s credentials.'))
    expect(always.tokenCalls()).toHaveLength(2)
  })

  it('follows pagination', async () => {
    const p = fakeProcore((url) => {
      const page = url.searchParams.get('page')
      if (page === '1') return Response.json([{ id: 1 }, { id: 2 }], { headers: { Link: `<https://sandbox.procore.com/x?page=2&per_page=100>; rel="next", <https://sandbox.procore.com/x?page=2>; rel="last"` } })
      return Response.json([{ id: 3 }], { headers: { Link: `<https://sandbox.procore.com/x?page=1>; rel="first"` } })
    })
    const client = createProcoreClient(CONFIG, { fetch: p.fetch })
    expect(await client.getAll('/x', { project_id: '7' })).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    expect(p.apiCalls().map((c) => [c.url.searchParams.get('page'), c.url.searchParams.get('per_page'), c.url.searchParams.get('project_id')])).toEqual([
      ['1', '100', '7'],
      ['2', '100', '7'],
    ])
  })

  it('stops after 50 pages', async () => {
    const p = fakeProcore(() => Response.json([{ id: 1 }], { headers: { Link: '<https://sandbox.procore.com/x?page=99>; rel="next"' } }))
    await expect(createProcoreClient(CONFIG, { fetch: p.fetch }).getAll('/x', {})).rejects.toBeInstanceOf(ProcoreError)
    expect(p.apiCalls()).toHaveLength(50)
  })

  it('waits for the rate limit once', async () => {
    const now = 1_700_000_000_000
    let n = 0
    const p = fakeProcore(() => (++n === 1 ? new Response('', { status: 429, headers: { 'X-Rate-Limit-Reset': String(now / 1000 + 3) } }) : Response.json([{ id: 1 }])))
    const sleep = vi.fn(async () => {})
    expect(await createProcoreClient(CONFIG, { fetch: p.fetch, now: () => now, sleep }).getAll('/x', {})).toEqual([{ id: 1 }])
    expect(sleep).toHaveBeenCalledWith(3000)
  })

  it('gives up when the rate limit resets too late', async () => {
    const now = 1_700_000_000_000
    const p = fakeProcore(() => new Response('', { status: 429, headers: { 'X-Rate-Limit-Reset': String(now / 1000 + 60) } }))
    const sleep = vi.fn(async () => {})
    await expect(createProcoreClient(CONFIG, { fetch: p.fetch, now: () => now, sleep }).getAll('/x', {})).rejects.toEqual(new ProcoreError('Procore is busy; try again in a minute.'))
    expect(sleep).not.toHaveBeenCalled()
  })

  it('treats 503 with Retry-After like a rate limit', async () => {
    let n = 0
    const p = fakeProcore(() => (++n === 1 ? new Response('', { status: 503, headers: { 'Retry-After': '2' } }) : Response.json([])))
    const sleep = vi.fn(async () => {})
    expect(await createProcoreClient(CONFIG, { fetch: p.fetch, sleep }).getAll('/x', {})).toEqual([])
    expect(sleep).toHaveBeenCalledWith(2000)
    const twice = fakeProcore(() => new Response('', { status: 503, headers: { 'Retry-After': '2' } }))
    await expect(createProcoreClient(CONFIG, { fetch: twice.fetch, sleep }).getAll('/x', {})).rejects.toEqual(new ProcoreError('Procore is busy; try again in a minute.'))
  })

  it('fails clearly', async () => {
    const refused = fakeProcore(() => Response.json([]), () => Response.json({ error: 'invalid_client', secret: SECRET }, { status: 401 }))
    await expect(createProcoreClient(CONFIG, { fetch: refused.fetch }).getAll('/x', {})).rejects.toEqual(new ProcoreError('Procore refused the app’s credentials.'))
    const bad = fakeProcore(() => Response.json([]), () => new Response('', { status: 400 }))
    await expect(createProcoreClient(CONFIG, { fetch: bad.fetch }).getAll('/x', {})).rejects.toEqual(new ProcoreError('Procore refused the app’s credentials.'))

    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(createProcoreClient(CONFIG, { fetch: offline }).getAll('/x', {})).rejects.toEqual(new ProcoreError('Could not reach Procore.'))

    const notFound = fakeProcore(() => new Response('nope', { status: 404 }))
    await expect(createProcoreClient(CONFIG, { fetch: notFound.fetch }).getAll('/x', {})).rejects.toEqual(new ProcoreError('Procore answered 404.'))

    const odd = fakeProcore(() => Response.json({ data: [] }))
    await expect(createProcoreClient(CONFIG, { fetch: odd.fetch }).getAll('/x', {})).rejects.toEqual(new ProcoreError('Procore sent an unexpected response.'))
  })

  it('times out a call that does not answer', async () => {
    const hang = vi.fn(
      (_input: unknown, init: RequestInit = {}) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        }),
    ) as unknown as typeof fetch
    await expect(createProcoreClient(CONFIG, { fetch: hang, timeoutMs: 20 }).getAll('/x', {})).rejects.toEqual(new ProcoreError('Could not reach Procore.'))
  })

  it('passes the caller’s abort through as-is', async () => {
    const controller = new AbortController()
    const hang = vi.fn(
      (input: unknown, init: RequestInit = {}) =>
        String(input).includes('/oauth/token')
          ? Promise.resolve(Response.json({ access_token: 't', expires_in: 5400 }))
          : new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
            }),
    ) as unknown as typeof fetch
    const pending = createProcoreClient(CONFIG, { fetch: hang }).getAll('/x', {}, controller.signal)
    setTimeout(() => controller.abort(), 5)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('never puts the secret in an error message', async () => {
    const leaky = fakeProcore(() => new Response(SECRET, { status: 500 }), undefined)
    const err = await createProcoreClient(CONFIG, { fetch: leaky.fetch })
      .getAll('/x', {})
      .catch((e: Error) => e)
    expect(err).toBeInstanceOf(ProcoreError)
    expect((err as Error).message).not.toContain(SECRET)
  })
})
