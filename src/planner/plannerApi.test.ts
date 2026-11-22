import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lleDraft } from '../test/plannerFixtures'
import { getAccessToken, getOptions, PlannerApiError, requestBatch, requestCommitted, requestDraft, requestImport, SESSION_EXPIRED_MESSAGE } from './plannerApi'
import type { BatchPlanRequest, PlannerOptions } from './types'

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

describe('requestBatch', () => {
  const draft = lleDraft()
  const batch: BatchPlanRequest = {
    scheduleType: 'lle-procurement',
    notes: 'Shared',
    items: [
      { equipmentType: 'Power transformer', equipmentName: 'T1', requiredDate: '2027-09-01' },
      { equipmentType: 'Switchgear', equipmentName: 'S1', requiredDate: '2027-10-01' },
    ],
  }

  it('POSTs the batch to draft-batch with the token and returns the results in order', async () => {
    const fetch = mockFetch(() =>
      reply(200, { ok: true, results: [{ ok: true, draft }, { ok: false, error: 'Unknown equipment type' }] }),
    )
    const results = await requestBatch('tok', batch)
    expect(results).toEqual([{ ok: true, draft }, { ok: false, error: 'Unknown equipment type' }])
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/api/planner/draft-batch')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual(batch)
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' })
  })

  it('a 429 shows the server message as a request error', async () => {
    mockFetch(() => reply(429, { ok: false, error: 'This request needs 2 drafts and you have 1 left' }))
    expect(await failure(requestBatch('t', batch))).toMatchObject({ kind: 'request', status: 429, message: expect.stringMatching(/needs 2 drafts/) })
  })

  it('401 means the session expired; ok: false at the top is a server error', async () => {
    mockFetch(() => reply(401, { error: 'jwt' }))
    expect((await failure(requestBatch('t', batch))).kind).toBe('session')
    mockFetch(() => reply(200, { ok: false, error: 'No catalog' }))
    expect(await failure(requestBatch('t', batch))).toMatchObject({ kind: 'server', message: 'No catalog' })
  })

  it('a reply without one result per item is an unexpected response', async () => {
    mockFetch(() => reply(200, { ok: true, results: [{ ok: true, draft }] }))
    expect((await failure(requestBatch('t', batch))).kind).toBe('response')
    mockFetch(() => reply(200, { ok: true }))
    expect((await failure(requestBatch('t', batch))).kind).toBe('response')
  })

  it('a malformed entry fails only that item', async () => {
    mockFetch(() => reply(200, { ok: true, results: [{ ok: true, draft }, { ok: true, draft: { nope: 1 } }] }))
    const results = await requestBatch('t', batch)
    expect(results[0]).toEqual({ ok: true, draft })
    expect(results[1]).toMatchObject({ ok: false })
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

describe('requestImport', () => {
  const body = { hints: { fileName: 'plan.xlsx', sheetNames: ['Plan'] }, activities: [{ code: 'A', name: 'Dig', phase: '', hasDuration: false, hasPredecessors: false }] }

  it('posts the request and returns the server’s answer', async () => {
    const answer = { ok: true, scheduleType: null, targetCode: null, durations: [{ code: 'A', days: 5, basis: 'estimate', reason: 'x' }], templateLinks: [], history: null }
    const fetch = mockFetch(() => reply(200, answer))
    expect(await requestImport('tok', body)).toEqual(answer)
    expect(fetch).toHaveBeenCalledWith('/api/planner/import', expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }))
  })

  it('returns a mapping answer as it is', async () => {
    mockFetch(() => reply(200, { ok: true, mapping: null }))
    expect(await requestImport('tok', { hints: body.hints, columns: [{ sheet: 'Plan', rows: [] }] })).toEqual({ ok: true, mapping: null })
  })

  it('turns a refusal or a malformed answer into an error', async () => {
    mockFetch(() => reply(429, { ok: false, error: 'You have reached the limit of 10 drafts per hour. Try again later.' }))
    expect((await failure(requestImport('tok', body))).message).toBe('You have reached the limit of 10 drafts per hour. Try again later.')
    mockFetch(() => reply(200, { ok: true }))
    expect((await failure(requestImport('tok', body))).kind).toBe('response')
  })
})

describe('requestCommitted', () => {
  it('POSTs the sheet’s projects to the Procore sync endpoint', async () => {
    const response = { ok: true, projects: [{ code: 'BKK-03', status: 'not-found' }] }
    const fetch = mockFetch(() => reply(200, response))
    const request = { projects: [{ code: 'BKK-03', costCodes: ['CHL'] }] }
    expect(await requestCommitted('tok', request)).toEqual(response)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/api/procore/committed')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(JSON.parse(String(init.body))).toEqual(request)
  })

  it('a reply without projects is an unexpected response', async () => {
    mockFetch(() => reply(200, { ok: true }))
    expect((await failure(requestCommitted('tok', { projects: [] }))).kind).toBe('response')
  })
})
