// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CATALOG, HISTORY, REQUEST, validProposal } from '../src/planner/__fixtures__/lle'
import type {
  BatchDraftResponse,
  BatchItemResult,
  BatchPlanRequest,
  DraftResponse,
  HistorySource,
  HistorySummary,
  PlannerOptions,
} from '../src/planner/types'
import type { AnthropicLike } from './ai'
import { createApp, type AppDeps } from './app'

type BetaMessage = Anthropic.Beta.Messages.BetaMessage
type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming

const OPTIONS: PlannerOptions = {
  scheduleTypes: [{ id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'LLE' }],
  equipmentTypes: { 'lle-procurement': ['Power transformer'] },
}
const ALL_HISTORY: HistorySummary = { ...HISTORY, equipmentType: null, projectCount: 20 }

function fakeSource(overrides: Partial<HistorySource> = {}): HistorySource {
  return {
    options: async () => OPTIONS,
    catalog: async () => CATALOG,
    summary: async (_type, equipment) => (equipment === null ? ALL_HISTORY : HISTORY),
    ...overrides,
  }
}

function message(content: unknown[], stop: string = 'tool_use'): BetaMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  } as unknown as BetaMessage
}
const toolCall = (input: unknown, id = 'toolu_1') => message([{ type: 'tool_use', id, name: 'propose_plan', input }])

type Reply = BetaMessage | Error | 'hang'
function fakeAnthropic(...replies: Reply[]) {
  const calls: CreateParams[] = []
  const create = vi.fn(async (body: CreateParams, opts?: { signal?: AbortSignal }) => {
    // Snapshot: the server keeps appending to the same messages array.
    calls.push(structuredClone(body))
    const reply = replies.shift()
    if (!reply) throw new Error('unexpected extra call')
    if (reply === 'hang') {
      return new Promise<BetaMessage>((_, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })))
      })
    }
    if (reply instanceof Error) throw reply
    return reply
  })
  const client: AnthropicLike = { beta: { messages: { create } } }
  return { client, calls, create }
}

let staticRoot: string
let secretDir: string
beforeAll(() => {
  secretDir = mkdtempSync(path.join(os.tmpdir(), 'planner-static-'))
  writeFileSync(path.join(secretDir, 'secret.txt'), 'TOP-SECRET')
  staticRoot = path.join(secretDir, 'dist')
  mkdirSync(path.join(staticRoot, 'assets'), { recursive: true })
  writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><title>app</title>')
  writeFileSync(path.join(staticRoot, 'assets', 'app-123.js'), 'console.log(1)')
  writeFileSync(path.join(staticRoot, 'assets', 'app-123.css'), 'body{}')
  writeFileSync(path.join(staticRoot, '.env'), 'SECRET=1')
})
afterAll(() => rmSync(secretDir, { recursive: true, force: true }))

let server: http.Server | null = null
let logs: { event: string; detail?: Record<string, unknown> }[] = []
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r))
  server = null
  logs = []
})

async function start(deps: Partial<AppDeps> = {}): Promise<string> {
  server = createApp({
    staticDir: staticRoot,
    authenticate: async (token) => (token === 'good-token' ? { userId: 'user-1', history: fakeSource() } : null),
    anthropic: null,
    log: (event, detail) => logs.push({ event, detail }),
    ...deps,
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const auth = { Authorization: 'Bearer good-token' }
function postDraft(base: string, body: unknown, headers: Record<string, string> = auth) {
  return fetch(`${base}/api/planner/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}
async function draftOf(res: Response) {
  expect(res.status).toBe(200)
  const body = (await res.json()) as DraftResponse
  if (!body.ok) throw new Error(body.error)
  return body.draft
}

/** A GET with the path sent exactly as given (fetch would normalize dot segments). */
function rawGet(base: string, rawPath: string): Promise<{ status: number; body: string; type?: string }> {
  const { port } = new URL(base)
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode!, body, type: res.headers['content-type'] }))
      })
      .on('error', reject)
  })
}

describe('health', () => {
  it('answers ok without auth', async () => {
    const base = await start()
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('auth', () => {
  it('rejects the planner endpoints without a token', async () => {
    const base = await start()
    const options = await fetch(`${base}/api/planner/options`)
    expect(options.status).toBe(401)
    expect(options.headers.get('www-authenticate')).toBe('Bearer')
    expect(await options.json()).toMatchObject({ ok: false })
    expect((await postDraft(base, REQUEST, {})).status).toBe(401)
  })

  it('rejects an invalid token and a malformed header', async () => {
    const base = await start()
    expect((await fetch(`${base}/api/planner/options`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await fetch(`${base}/api/planner/options`, { headers: { Authorization: 'Basic good-token' } })).status).toBe(401)
    expect((await postDraft(base, REQUEST, { Authorization: 'Bearer nope' })).status).toBe(401)
  })

  it('serves the options to a valid token', async () => {
    const base = await start()
    const res = await fetch(`${base}/api/planner/options`, { headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(OPTIONS)
  })

  it('answers 503 when verification fails or Supabase is not configured', async () => {
    let base = await start({ authenticate: async () => Promise.reject(new Error('supabase down')) })
    expect((await fetch(`${base}/api/planner/options`, { headers: auth })).status).toBe(503)
    await new Promise((r) => server!.close(r))
    base = await start({ authenticate: null })
    expect((await fetch(`${base}/api/planner/options`, { headers: auth })).status).toBe(503)
  })
})

describe('draft request validation', () => {
  const cases: [string, unknown, RegExp][] = [
    ['unknown schedule type', { ...REQUEST, scheduleType: 'rocket-launch' }, /schedule type/i],
    ['impossible date', { ...REQUEST, requiredDate: '2027-02-30' }, /requiredDate/],
    ['non-ISO date', { ...REQUEST, requiredDate: '01/09/2027' }, /requiredDate/],
    ['missing equipment name', { ...REQUEST, equipmentName: '  ' }, /equipmentName/],
    ['non-string equipment type', { ...REQUEST, equipmentType: 42 }, /equipmentType/],
    ['overlong notes', { ...REQUEST, notes: 'x'.repeat(2001) }, /notes/],
    ['array body', [REQUEST], /object/],
    ['invalid JSON', '{"scheduleType":', /JSON/],
  ]
  it.each(cases)('rejects %s with 400', async (_name, body, pattern) => {
    const base = await start()
    const res = await postDraft(base, body)
    expect(res.status).toBe(400)
    const json = (await res.json()) as DraftResponse
    expect(json.ok).toBe(false)
    if (!json.ok) expect(json.error).toMatch(pattern)
  })

  it('rejects a non-JSON content type with 415 and an oversized body with 413', async () => {
    const base = await start()
    const text = await fetch(`${base}/api/planner/draft`, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: 'hi' })
    expect(text.status).toBe(415)
    const big = await postDraft(base, { ...REQUEST, notes: 'x'.repeat(40_000) })
    expect(big.status).toBe(413)
  })

  it('rejects the wrong method with 405 and unknown API paths with 404', async () => {
    const base = await start()
    expect((await fetch(`${base}/api/planner/draft`, { headers: auth })).status).toBe(405)
    const unknown = await fetch(`${base}/api/nothing`)
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('content-type')).toMatch(/json/)
  })
})

describe('drafting', () => {
  it('passes a valid AI draft through', async () => {
    const ai = fakeAnthropic(toolCall(validProposal()))
    const base = await start({ anthropic: ai.client, model: 'claude-opus-5-5' })
    const draft = await draftOf(await postDraft(base, { ...REQUEST, notes: 'Use conservative durations for fabrication.' }))

    expect(draft.source).toBe('ai')
    expect(draft.targetCode).toBe('SITE')
    expect(draft.activities.find((a) => a.code === 'FAB')).toMatchObject({ durationDays: 170, basis: 'p80' })
    expect(draft.request.notes).toBe('Use conservative durations for fabrication.')
    expect(draft.history).toEqual(HISTORY)
    expect(draft.assumptions.some((a) => /SAMPLE/.test(a))).toBe(true)
    expect(draft.assumptions).toContain('Vendor already prequalified.')
    expect(ai.create).toHaveBeenCalledTimes(1)

    const params = ai.calls[0]
    expect(params.model).toBe('claude-opus-5-5')
    expect(params.tools).toHaveLength(1)
    expect(params.tools![0]).toMatchObject({ name: 'propose_plan', strict: true })
    expect(params.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
    const prompt = params.messages[0].content as string
    expect(prompt).toContain('400 MVA transformer for substation B')
    expect(prompt).toContain('"code": "FAB"')
    expect(prompt).toContain('"p80": 170')
    expect(prompt).toContain('<planner_notes>\nUse conservative durations for fabrication.\n</planner_notes>')
    expect(JSON.stringify(params.system)).toMatch(/Never produce calendar dates/)
  })

  it('retries once with the validation errors, then accepts a corrected draft', async () => {
    const bad = { ...validProposal(), targetCode: 'SHIP' }
    const ai = fakeAnthropic(toolCall(bad, 'toolu_bad'), toolCall(validProposal(), 'toolu_good'))
    const base = await start({ anthropic: ai.client })
    const draft = await draftOf(await postDraft(base, REQUEST))
    expect(draft.source).toBe('ai')
    expect(ai.create).toHaveBeenCalledTimes(2)
    const retry = ai.calls[1].messages
    expect(retry).toHaveLength(3)
    expect(retry[1].role).toBe('assistant')
    const result = (retry[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[])[0]
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_bad', is_error: true })
    expect(String(result.content)).toMatch(/targetCode must be the catalog target SITE/)
  })

  it('falls back to the history draft when the AI draft is invalid twice', async () => {
    const bad = validProposal()
    bad.links.push({ from: 'FAB', to: 'DWG', type: 'FS', lagDays: 0 })
    const ai = fakeAnthropic(toolCall(bad), toolCall(bad))
    const base = await start({ anthropic: ai.client })
    const draft = await draftOf(await postDraft(base, REQUEST))
    expect(ai.create).toHaveBeenCalledTimes(2)
    expect(draft.source).toBe('history')
    expect(draft.assumptions[0]).toMatch(/failed validation twice/)
    expect(draft.activities.find((a) => a.code === 'FAB')).toMatchObject({ durationDays: 140, basis: 'p50' })
    expect(logs.filter((l) => l.event === 'planner.ai.invalid')).toHaveLength(2)
  })

  it('re-prompts when the model answers without calling the tool', async () => {
    const ai = fakeAnthropic(message([{ type: 'text', text: 'Here is a plan...' }], 'end_turn'), toolCall(validProposal()))
    const base = await start({ anthropic: ai.client })
    expect((await draftOf(await postDraft(base, REQUEST))).source).toBe('ai')
    expect(ai.calls[1].messages[2]).toMatchObject({ role: 'user', content: expect.stringMatching(/call propose_plan/i) })
  })

  it('builds a history-only draft when no API key is configured', async () => {
    const base = await start({ anthropic: null })
    const draft = await draftOf(await postDraft(base, REQUEST))
    expect(draft.source).toBe('history')
    expect(draft.assumptions[0]).toMatch(/not configured/)
    expect(draft.activities).toHaveLength(CATALOG.length)
  })

  it('falls back on an upstream error without leaking it', async () => {
    const upstream = Object.assign(new Error('500 {"error":"overloaded sk-ant-api03-SECRET"}'), { name: 'InternalServerError', status: 500 })
    const ai = fakeAnthropic(upstream)
    const base = await start({ anthropic: ai.client })
    const res = await postDraft(base, REQUEST)
    const text = await res.clone().text()
    expect(text).not.toMatch(/SECRET|overloaded/)
    const draft = await draftOf(res)
    expect(draft.source).toBe('history')
    expect(draft.assumptions[0]).toMatch(/unavailable/)
    expect(logs.find((l) => l.event === 'planner.ai.error')?.detail).toMatchObject({ status: 500 })
  })

  it('falls back when the AI does not answer before the deadline', async () => {
    const ai = fakeAnthropic('hang')
    const base = await start({ anthropic: ai.client, aiDeadlineMs: 50 })
    const draft = await draftOf(await postDraft(base, REQUEST))
    expect(draft.source).toBe('history')
    expect(draft.assumptions[0]).toMatch(/too long/)
  })

  it('falls back when the model refuses', async () => {
    const ai = fakeAnthropic(message([], 'refusal'))
    const base = await start({ anthropic: ai.client })
    const draft = await draftOf(await postDraft(base, REQUEST))
    expect(draft.source).toBe('history')
    expect(ai.create).toHaveBeenCalledTimes(1)
  })

  it('uses the whole schedule type history when the equipment has fewer than 3 projects', async () => {
    const thin: HistorySummary = { ...HISTORY, projectCount: 2 }
    const summary = vi.fn(async (_t: string, equipment: string | null) => (equipment === null ? ALL_HISTORY : thin))
    const base = await start({ authenticate: async () => ({ userId: 'user-1', history: fakeSource({ summary }) }) })
    const draft = await draftOf(await postDraft(base, REQUEST))
    expect(summary).toHaveBeenCalledWith('lle-procurement', null)
    expect(draft.history.equipmentType).toBeNull()
    expect(draft.assumptions.some((a) => /Only 2 historical projects for Power transformer.*all equipment types \(20 projects\)/.test(a))).toBe(true)
  })

  it('answers 502 without details when the history cannot be read', async () => {
    const base = await start({ authenticate: async () => ({ userId: 'user-1', history: fakeSource({ catalog: async () => Promise.reject(new Error('relation does not exist')) }) }) })
    const res = await postDraft(base, REQUEST)
    expect(res.status).toBe(502)
    expect(await res.text()).not.toMatch(/relation/)
  })
})

describe('static files', () => {
  it('serves index.html, assets with content types, and the SPA fallback', async () => {
    const base = await start()
    const index = await fetch(`${base}/`)
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await index.text()).toContain('<title>app</title>')

    const js = await fetch(`${base}/assets/app-123.js`)
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(js.headers.get('cache-control')).toMatch(/immutable/)
    expect(await js.text()).toBe('console.log(1)')
    expect((await fetch(`${base}/assets/app-123.css`)).headers.get('content-type')).toBe('text/css; charset=utf-8')

    const route = await fetch(`${base}/sheets/abc?tab=gantt`)
    expect(route.status).toBe(200)
    expect(await route.text()).toContain('<title>app</title>')

    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404)
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405)
  })

  it.each(['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/..\\secret.txt', '/.env', '/%00index.html'])(
    'blocks %s',
    async (p) => {
      const base = await start()
      const res = await rawGet(base, p)
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.body).not.toContain('TOP-SECRET')
      expect(res.body).not.toContain('SECRET=1')
    },
  )
})

describe('draft limits and cancellation (security review)', () => {
  it('a second draft from the same user while one is running gets 429 with Retry-After', async () => {
    const ai = fakeAnthropic('hang')
    const base = await start({ anthropic: ai.client, aiDeadlineMs: 5_000 })
    const first = postDraft(base, REQUEST).catch(() => null)
    await vi.waitFor(() => expect(ai.create).toHaveBeenCalledTimes(1))
    const second = await postDraft(base, REQUEST)
    expect(second.status).toBe(429)
    expect(second.headers.get('retry-after')).toBeTruthy()
    expect(((await second.json()) as DraftResponse).ok).toBe(false)
    server!.closeAllConnections()
    await first
  })

  it('caps drafts per user per hour', async () => {
    const base = await start({ draftLimits: { perUserPerHour: 2, perUserInFlight: 1, globalInFlight: 8 } })
    await draftOf(await postDraft(base, REQUEST))
    await draftOf(await postDraft(base, REQUEST))
    const third = await postDraft(base, REQUEST)
    expect(third.status).toBe(429)
    expect(((await third.json()) as { error: string }).error).toMatch(/2 drafts per hour/)
  })

  it('a bad request does not use up the hourly quota', async () => {
    const base = await start({ draftLimits: { perUserPerHour: 1, perUserInFlight: 1, globalInFlight: 8 } })
    expect((await postDraft(base, { ...REQUEST, requiredDate: 'soon' })).status).toBe(400)
    await draftOf(await postDraft(base, REQUEST))
  })

  it('aborts the AI call when the client disconnects, and frees the slot', async () => {
    const ai = fakeAnthropic('hang')
    const base = await start({ anthropic: ai.client, aiDeadlineMs: 60_000 })
    const controller = new AbortController()
    const pending = fetch(`${base}/api/planner/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(REQUEST),
      signal: controller.signal,
    }).catch(() => null)
    await vi.waitFor(() => expect(ai.create).toHaveBeenCalledTimes(1))
    const signal = (ai.create.mock.calls[0][1] as { signal: AbortSignal }).signal
    expect(signal.aborted).toBe(false)
    controller.abort()
    await pending
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
    await vi.waitFor(() => expect(logs.some((l) => l.event === 'planner.ai.cancelled')).toBe(true))
    // The same server frees the user's slot: the next draft is served (the fake has no more AI
    // replies, so it falls back to history).
    const next = await draftOf(await postDraft(base, REQUEST))
    expect(next.source).toBe('history')
  })
})

const BATCH: BatchPlanRequest = {
  scheduleType: 'lle-procurement',
  notes: 'Shared note',
  items: [
    { equipmentType: 'Power transformer', equipmentName: '400 MVA transformer, Substation B', requiredDate: '2027-09-01' },
    { equipmentType: 'Switchgear', equipmentName: '132 kV GIS', requiredDate: '2027-11-15', notes: 'Indoor type' },
    { equipmentType: 'Chiller', equipmentName: '2 MW chiller', requiredDate: '2027-12-01' },
  ],
}

function postBatch(base: string, body: unknown, headers: Record<string, string> = auth) {
  return fetch(`${base}/api/planner/draft-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}
async function resultsOf(res: Response): Promise<BatchItemResult[]> {
  expect(res.status).toBe(200)
  const body = (await res.json()) as BatchDraftResponse
  if (!body.ok) throw new Error(body.error)
  return body.results
}
const okDraft = (r: BatchItemResult) => {
  if (!r.ok) throw new Error(r.error)
  return r.draft
}

describe('POST /api/planner/draft-batch', () => {
  it('needs the same auth as /draft', async () => {
    const base = await start()
    expect((await postBatch(base, BATCH, {})).status).toBe(401)
    expect((await postBatch(base, BATCH, { Authorization: 'Bearer nope' })).status).toBe(401)
    await new Promise((r) => server!.close(r))
    const unconfigured = await start({ authenticate: null })
    expect((await postBatch(unconfigured, BATCH)).status).toBe(503)
    const get = await fetch(`${unconfigured}/api/planner/draft-batch`, { headers: auth })
    expect(get.status).toBe(405)
  })

  it('drafts every item in order, with shared and per-item notes, from history when no AI is configured', async () => {
    const base = await start({ anthropic: null })
    const results = await resultsOf(await postBatch(base, BATCH))
    expect(results).toHaveLength(3)
    const drafts = results.map(okDraft)
    expect(drafts.map((d) => d.request.equipmentName)).toEqual(['400 MVA transformer, Substation B', '132 kV GIS', '2 MW chiller'])
    expect(drafts.map((d) => d.request.requiredDate)).toEqual(['2027-09-01', '2027-11-15', '2027-12-01'])
    expect(drafts.map((d) => d.request.notes)).toEqual(['Shared note', 'Shared note\nIndoor type', 'Shared note'])
    expect(drafts.every((d) => d.source === 'history' && d.request.scheduleType === 'lle-procurement')).toBe(true)
    expect(logs.find((l) => l.event === 'planner.batch')?.detail).toMatchObject({ items: 3, failed: 0 })
  })

  it('one AI call per item, at most two at a time', async () => {
    let running = 0
    let peak = 0
    const create = vi.fn(async (_body: CreateParams) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 25))
      running--
      return toolCall(validProposal())
    })
    const client: AnthropicLike = { beta: { messages: { create } } }
    const base = await start({ anthropic: client })
    const results = await resultsOf(await postBatch(base, { ...BATCH, items: [...BATCH.items, ...BATCH.items] }))
    expect(results.map(okDraft).every((d) => d.source === 'ai')).toBe(true)
    expect(create).toHaveBeenCalledTimes(6)
    expect(peak).toBe(2)
  })

  it('a whole-batch time limit: items still waiting when it runs out are drafted from history alone', async () => {
    const hang = fakeAnthropic('hang', 'hang', 'hang')
    const base = await start({ anthropic: hang.client, batchConcurrency: 1, batchDeadlineMs: 150, aiDeadlineMs: 60_000 })
    const started = Date.now()
    const drafts = (await resultsOf(await postBatch(base, BATCH))).map(okDraft)
    expect(Date.now() - started).toBeLessThan(5_000) // bounded by the batch limit, not by 3 x the per-item limit
    expect(drafts.map((d) => d.source)).toEqual(['history', 'history', 'history'])
    expect(hang.create).toHaveBeenCalledTimes(1) // the others never called the AI
    expect(drafts[0].assumptions[0]).toMatch(/took too long/)
    expect(drafts[1].assumptions[0]).toMatch(/time limit for a batch/i)
    expect(drafts[2].assumptions[0]).toMatch(/time limit for a batch/i)
  })

  it('the concurrency is configurable', async () => {
    let running = 0
    let peak = 0
    const create = vi.fn(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 25))
      running--
      return toolCall(validProposal())
    })
    const base = await start({ anthropic: { beta: { messages: { create } } }, batchConcurrency: 3 })
    await resultsOf(await postBatch(base, BATCH))
    expect(peak).toBe(3)
  })

  it('one failing item does not lose the others', async () => {
    const source = fakeSource({
      summary: async (_t, equipment) => {
        if (equipment === 'Switchgear') throw new Error('relation does not exist')
        return equipment === null ? ALL_HISTORY : HISTORY
      },
    })
    const base = await start({ authenticate: async () => ({ userId: 'user-1', history: source }) })
    const results = await resultsOf(await postBatch(base, BATCH))
    expect(results.map((r) => r.ok)).toEqual([true, false, true])
    const failed = results[1]
    expect(!failed.ok && failed.error).toBe('Could not read the planner history.')
    expect(JSON.stringify(results)).not.toMatch(/relation/)
    expect(logs.find((l) => l.event === 'planner.batch')?.detail).toMatchObject({ failed: 1 })
  })

  it('an item whose AI draft is invalid falls back to history on its own', async () => {
    const bad = { ...validProposal(), targetCode: 'SHIP' }
    // Item order is not guaranteed across concurrent workers, so answer by the equipment in the prompt.
    const create = vi.fn(async (body: CreateParams) => {
      const prompt = JSON.stringify(body.messages[0].content)
      return toolCall(prompt.includes('132 kV GIS') ? bad : validProposal())
    })
    const base = await start({ anthropic: { beta: { messages: { create } } } })
    const drafts = (await resultsOf(await postBatch(base, BATCH))).map(okDraft)
    expect(drafts.map((d) => d.source)).toEqual(['ai', 'history', 'ai'])
  })

  const invalid: [string, unknown, RegExp][] = [
    ['no items', { ...BATCH, items: [] }, /items/],
    ['items not a list', { ...BATCH, items: 'x' }, /items/],
    ['7 items', { ...BATCH, items: Array.from({ length: 7 }, () => BATCH.items[0]) }, /at most 6/],
    ['an item that is not an object', { ...BATCH, items: [BATCH.items[0], 5] }, /items\[1\] must be an object/],
    ['a blank equipment name', { ...BATCH, items: [BATCH.items[0], { ...BATCH.items[1], equipmentName: ' ' }] }, /items\[1\]: equipmentName/],
    ['an impossible date', { ...BATCH, items: [{ ...BATCH.items[0], requiredDate: '2027-02-30' }] }, /items\[0\]: requiredDate/],
    ['a non-string equipment type', { ...BATCH, items: [{ ...BATCH.items[0], equipmentType: 4 }] }, /items\[0\]: equipmentType/],
    ['control characters in a name', { ...BATCH, items: [{ ...BATCH.items[0], equipmentName: 'a\u0000b' }] }, /control characters/],
    ['overlong item notes', { ...BATCH, items: [{ ...BATCH.items[0], notes: 'x'.repeat(2001) }] }, /items\[0\]: notes/],
    ['missing schedule type', { items: BATCH.items }, /scheduleType/],
    ['overlong shared notes', { ...BATCH, notes: 'x'.repeat(2001) }, /notes/],
    ['array body', [BATCH], /object/],
    ['invalid JSON', '{"items":', /JSON/],
  ]
  it.each(invalid)('rejects %s with 400', async (_name, body, pattern) => {
    const base = await start()
    const res = await postBatch(base, body)
    expect(res.status).toBe(400)
    const json = (await res.json()) as BatchDraftResponse
    expect(json.ok).toBe(false)
    if (!json.ok) expect(json.error).toMatch(pattern)
  })

  it('rejects an unknown schedule type with 400 before spending any quota', async () => {
    const base = await start({ draftLimits: { perUserPerHour: 3, perUserInFlight: 1, globalInFlight: 8 } })
    const res = await postBatch(base, { ...BATCH, scheduleType: 'rocket-launch' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/schedule type/i)
    expect((await resultsOf(await postBatch(base, BATCH))).length).toBe(3) // the whole quota is still there
  })

  it('answers 415 for a non-JSON content type and 413 for a body over 16 KiB', async () => {
    const base = await start()
    const text = await fetch(`${base}/api/planner/draft-batch`, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: 'hi' })
    expect(text.status).toBe(415)
    const big = await postBatch(base, { ...BATCH, notes: 'x'.repeat(40_000) })
    expect(big.status).toBe(413)
  })

  it('answers 502 without details when the schedule types cannot be read', async () => {
    const source = fakeSource({ options: async () => Promise.reject(new Error('relation does not exist')) })
    const base = await start({ authenticate: async () => ({ userId: 'user-1', history: source }) })
    const res = await postBatch(base, BATCH)
    expect(res.status).toBe(502)
    expect(await res.text()).not.toMatch(/relation/)
  })

  it('a batch uses ONE slot in flight: a second request from the same user gets 429', async () => {
    const ai = fakeAnthropic('hang', 'hang', 'hang')
    const base = await start({ anthropic: ai.client, aiDeadlineMs: 5_000 })
    const first = postBatch(base, BATCH).catch(() => null)
    await vi.waitFor(() => expect(ai.create).toHaveBeenCalledTimes(2)) // two of three items in flight
    const second = await postBatch(base, BATCH)
    expect(second.status).toBe(429)
    expect(second.headers.get('retry-after')).toBeTruthy()
    const single = await postDraft(base, REQUEST)
    expect(single.status).toBe(429)
    server!.closeAllConnections()
    await first
  })

  it('each item counts against the per-user hourly quota; a batch over it is refused whole', async () => {
    const base = await start({ draftLimits: { perUserPerHour: 5, perUserInFlight: 1, globalInFlight: 8 } })
    await resultsOf(await postBatch(base, BATCH)) // 3 of 5
    const refused = await postBatch(base, BATCH) // would be 6
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(((await refused.json()) as { error: string }).error).toMatch(/needs 3 drafts and you have 2 left/)
    // Nothing was partially spent: the 2 left still work, as a batch or as single drafts.
    const two = await resultsOf(await postBatch(base, { ...BATCH, items: BATCH.items.slice(0, 2) }))
    expect(two).toHaveLength(2)
    expect((await postDraft(base, REQUEST)).status).toBe(429)
  })

  it('a single /draft counts one unit of the same quota', async () => {
    const base = await start({ draftLimits: { perUserPerHour: 4, perUserInFlight: 1, globalInFlight: 8 } })
    await draftOf(await postDraft(base, REQUEST))
    await resultsOf(await postBatch(base, BATCH)) // 1 + 3 = 4
    expect((await postBatch(base, { ...BATCH, items: BATCH.items.slice(0, 1) })).status).toBe(429)
  })

  it('each item counts against the global hourly quota with 503 and Retry-After', async () => {
    const base = await start({ draftLimits: { perUserPerHour: 10, perUserInFlight: 1, globalInFlight: 8, globalPerHour: 4 } })
    await resultsOf(await postBatch(base, BATCH))
    const refused = await postBatch(base, BATCH)
    expect(refused.status).toBe(503)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('aborts every item when the client disconnects, never starts the rest, and frees the slot and the unused quota', async () => {
    const ai = fakeAnthropic('hang', 'hang')
    const base = await start({ anthropic: ai.client, aiDeadlineMs: 60_000, draftLimits: { perUserPerHour: 3, perUserInFlight: 1, globalInFlight: 8 } })
    const controller = new AbortController()
    const pending = fetch(`${base}/api/planner/draft-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(BATCH),
      signal: controller.signal,
    }).catch(() => null)
    await vi.waitFor(() => expect(ai.create).toHaveBeenCalledTimes(2))
    const signals = ai.create.mock.calls.map((c) => (c[1] as { signal: AbortSignal }).signal)
    expect(signals.every((s) => !s.aborted)).toBe(true)
    controller.abort()
    await pending
    await vi.waitFor(() => expect(signals.every((s) => s.aborted)).toBe(true))
    await vi.waitFor(() => expect(logs.some((l) => l.event === 'planner.batch.abandoned')).toBe(true))
    expect(ai.create).toHaveBeenCalledTimes(2) // the third item was never started
    expect(logs.find((l) => l.event === 'planner.batch.abandoned')?.detail).toMatchObject({ items: 3, started: 2 })
    // The slot is free, and only the 2 started items stayed charged: 1 of 3 is left (no more AI replies: history).
    const next = await draftOf(await postDraft(base, REQUEST))
    expect(next.source).toBe('history')
    expect((await postDraft(base, REQUEST)).status).toBe(429)
  })

  it('keeps /draft unchanged next to it', async () => {
    const base = await start()
    const draft = await draftOf(await postDraft(base, REQUEST))
    expect(draft.request).toEqual(REQUEST)
  })
})

describe('anti-framing headers', () => {
  it('pages and assets may not be framed by another site', async () => {
    const base = await start()
    for (const p of ['/', '/assets/app-123.js', '/some/client/route']) {
      const res = await fetch(`${base}${p}`)
      expect(res.headers.get('x-frame-options'), p).toBe('DENY')
      expect(res.headers.get('content-security-policy'), p).toBe("frame-ancestors 'none'")
      expect(res.headers.get('referrer-policy'), p).toBe('strict-origin-when-cross-origin')
    }
  })
})
