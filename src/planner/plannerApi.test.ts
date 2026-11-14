import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lleDraft } from '../test/plannerFixtures'
import { getAccessToken, getOptions, PlannerApiError, requestDraft, SESSION_EXPIRED_MESSAGE } from './plannerApi'
import type { PlannerOptions } from './types'

const OPTIONS: PlannerOptions = {
  scheduleTypes: [{ id: 'lle-procurement', name: 'LLE procurement', description: 'Long-lead equipment' }],
  equipmentTypes: { 'lle-procurement': ['Power transformer', 'Switchgear'] },
}

function reply(status: number, body: unknown, raw = false) {
  return new Response(raw ? (body as string) : JSON.stringify(body), { status, headers: { 'Content-Type': raw ? 'text/html' : 'application/json' } })
}

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn(async (url: string, init: RequestInit) => impl(url, init))
  vi.stubGlobal('fetch', fn)
  return fn
}

/** Runs the promise and returns the PlannerApiError it rejects with. */
async function failure(p: Promise<unknown>): Promise<PlannerApiError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(PlannerApiError)
    return err as PlannerApiError
  }
  throw new Error('expected a rejection')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getOptions', () => {
  it('GETs the same-origin endpoint with the bearer token', async () => {
    const fetch = mockFetch(() => reply(200, OPTIONS))
    await expect(getOptions('tok-1')).resolves.toEqual(OPTIONS)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/api/planner/options')
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
  })

  it('401 means the session expired', async () => {
    mockFetch(() => reply(401, { error: 'invalid JWT' }))
    const err = await failure(getOptions('t'))
    expect(err).toMatchObject({ kind: 'session', status: 401, message: SESSION_EXPIRED_MESSAGE })
  })

  it('a 4xx shows the server message, or a generic one', async () => {
    mockFetch(() => reply(403, { error: 'Planner is not enabled for your organization' }))
    expect(await failure(getOptions('t'))).toMatchObject({ kind: 'request', status: 403, message: 'Planner is not enabled for your organization' })
    mockFetch(() => reply(404, 'Not found', true))
    expect((await failure(getOptions('t'))).message).toBe('The planner could not handle the request (404).')
  })

  it('a 5xx is a server error', async () => {
    mockFetch(() => reply(502, '<html>Bad gateway</html>', true))
    expect(await failure(getOptions('t'))).toMatchObject({
      kind: 'server',
      status: 502,
      message: 'The planning server is unavailable (502). Try again in a moment.',
    })
    mockFetch(() => reply(500, { error: 'history query failed' }))
    expect((await failure(getOptions('t'))).message).toBe('The planning server failed: history query failed')
  })

  it('a network failure says the server could not be reached', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    expect(await failure(getOptions('t'))).toMatchObject({ kind: 'network', status: null })
  })

  it('an HTML page or a wrong shape is an unexpected response', async () => {
    mockFetch(() => reply(200, '<!doctype html><title>app</title>', true))
    expect((await failure(getOptions('t'))).kind).toBe('response')
    mockFetch(() => reply(200, { scheduleTypes: 'nope' }))
    expect((await failure(getOptions('t'))).kind).toBe('response')
  })

  it('an abort propagates as an AbortError, not a planner error', async () => {
    mockFetch(() => Promise.reject(new DOMException('aborted', 'AbortError')))
    await expect(getOptions('t')).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('requestDraft', () => {
  const draft = lleDraft()

  it('POSTs the request as JSON and returns the draft', async () => {
    const fetch = mockFetch(() => reply(200, { ok: true, draft }))
    await expect(requestDraft('tok', draft.request)).resolves.toEqual(draft)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/api/planner/draft')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual(draft.request)
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' })
  })

  it('ok: false carries the server error', async () => {
    mockFetch(() => reply(200, { ok: false, error: 'No catalog for this schedule type' }))
    expect(await failure(requestDraft('t', draft.request))).toMatchObject({ kind: 'server', message: 'No catalog for this schedule type' })
  })

  it('a 400 with ok: false shows the validation message', async () => {
    mockFetch(() => reply(400, { ok: false, error: 'requiredDate must be YYYY-MM-DD' }))
    expect(await failure(requestDraft('t', draft.request))).toMatchObject({ kind: 'request', status: 400, message: 'requiredDate must be YYYY-MM-DD' })
  })

  it('a draft without activities is an unexpected response', async () => {
    mockFetch(() => reply(200, { ok: true, draft: { ...draft, activities: undefined } }))
    expect((await failure(requestDraft('t', draft.request))).kind).toBe('response')
  })
})

describe('getAccessToken', () => {
  const client = (session: unknown, error: unknown = null) =>
    ({ auth: { getSession: async () => ({ data: { session }, error }) } }) as unknown as SupabaseClient

  it('returns the session access token', async () => {
    await expect(getAccessToken(client({ access_token: 'abc' }))).resolves.toBe('abc')
  })

  it('no session is a session error', async () => {
    expect((await failure(getAccessToken(client(null)))).kind).toBe('session')
    expect((await failure(getAccessToken(client({ access_token: 'x' }, { message: 'boom' })))).kind).toBe('session')
  })
})
