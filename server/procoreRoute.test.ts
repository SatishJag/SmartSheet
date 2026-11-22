// @vitest-environment node
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommittedResponse, HistorySource, PlannerOptions } from '../src/planner/types'
import { createApp, type AppDeps } from './app'
import { ProcoreError, type ProcoreClient } from './procore'

const OPTIONS: PlannerOptions = {
  scheduleTypes: [],
  equipmentTypes: {},
  projects: [
    { code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true },
    { code: 'VIL-01', name: 'Sample villa', isProgram: false, projectType: 'properties', inProcore: false },
  ],
}

function source(options: () => Promise<PlannerOptions> = async () => OPTIONS): HistorySource {
  return { options, catalog: async () => [], summary: async () => ({ scheduleType: '', equipmentType: null, projectCount: 0, sampleOnly: false, stats: [] }) }
}

/** A Procore with one project, BKK-03 (id 7), one approved subcontract on CHL. */
function fakeProcore(overrides: Partial<Record<string, () => unknown[]>> = {}) {
  const routes: Record<string, () => unknown[]> = {
    '/rest/v1.1/projects': () => [{ id: 7, project_number: 'BKK-03' }],
    '/rest/v1.0/work_order_contracts': () => [{ id: 1, status: 'Approved' }],
    '/rest/v1.0/purchase_order_contracts': () => [],
    '/rest/v1.0/work_order_contracts/1/line_items': () => [{ amount: '1250000', cost_code: { code: 'CHL' } }],
    '/rest/v1.0/cost_codes': () => [{ code: 'CHL' }, { code: 'GEN' }],
    ...overrides,
  }
  const client: ProcoreClient = {
    companyId: '42',
    get: vi.fn() as unknown as ProcoreClient['get'],
    getAll: vi.fn(async <T,>(path: string, query: Record<string, string>) => {
      void query
      const r = routes[path]
      if (!r) throw new Error(`unexpected ${path}`)
      return r() as T[]
    }) as unknown as ProcoreClient['getAll'],
  }
  return client
}

let server: http.Server | null = null
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r))
  server = null
})

async function start(deps: Partial<AppDeps> = {}, options?: () => Promise<PlannerOptions>): Promise<string> {
  server = createApp({
    staticDir: '/nonexistent',
    authenticate: async (token) => (token === 'good-token' ? { userId: 'user-1', history: source(options) } : null),
    anthropic: null,
    log: () => {},
    ...deps,
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const BODY = { projects: [{ code: 'BKK-03', costCodes: ['CHL', 'GEN'] }] }
function post(base: string, body: unknown = BODY, token = 'good-token') {
  return fetch(`${base}/api/procore/committed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
}

describe('POST /api/procore/committed', () => {
  it('needs a signed-in user', async () => {
    const base = await start({ procore: fakeProcore() })
    expect((await post(base, BODY, '')).status).toBe(401)
  })

  it('answers 503 when Procore is not set up', async () => {
    for (const procore of [null, undefined]) {
      const base = await start({ procore })
      const res = await post(base)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ ok: false, error: 'Procore is not set up on this server.' })
      await new Promise((r) => server!.close(r))
      server = null
    }
  })

  it('refuses an invalid body', async () => {
    const base = await start({ procore: fakeProcore() })
    const res = await post(base, { projects: [] })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'Send at least one project to sync.' })
  })

  it('syncs listed projects in Procore and skips the rest', async () => {
    const procore = fakeProcore()
    const base = await start({ procore })
    const res = await post(base, {
      projects: [
        { code: 'BKK-03', costCodes: ['chl', 'GEN'] },
        { code: 'VIL-01', costCodes: ['CHL'] },
        { code: 'ZZZ-9', costCodes: ['CHL'] },
      ],
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as CommittedResponse).toEqual({
      ok: true,
      projects: [
        {
          code: 'BKK-03',
          status: 'ok',
          costCodes: [
            { code: 'CHL', committed: 1250000, awarded: true, known: true },
            { code: 'GEN', committed: 0, awarded: false, known: true },
          ],
        },
        { code: 'VIL-01', status: 'not-in-procore' },
        { code: 'ZZZ-9', status: 'not-in-procore' },
      ],
    })
    const asked = vi.mocked(procore.getAll).mock.calls.filter((c) => c[0] === '/rest/v1.1/projects').map((c) => c[1]['filters[project_number]'])
    expect(asked).toEqual(['BKK-03'])
  })

  it('fails the whole sync when Procore fails', async () => {
    const base = await start({
      procore: fakeProcore({
        '/rest/v1.0/purchase_order_contracts': () => {
          throw new ProcoreError('Procore is busy; try again in a minute.')
        },
      }),
    })
    const res = await post(base)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, error: 'Could not sync with Procore: Procore is busy; try again in a minute.' })
  })

  it('answers 502 when the project list cannot be read', async () => {
    const base = await start({ procore: fakeProcore() }, async () => {
      throw new Error('db down')
    })
    const res = await post(base)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, error: 'Could not read the project list.' })
  })

  it('lets one sync run at a time per user', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow = fakeProcore()
    const getAll = slow.getAll
    slow.getAll = (async (path: string, query: Record<string, string>) => {
      if (path === '/rest/v1.1/projects') await gate
      return getAll(path, query)
    }) as ProcoreClient['getAll']
    const base = await start({ procore: slow })
    const first = post(base)
    await new Promise((r) => setTimeout(r, 30))
    const second = await post(base)
    expect(second.status).toBe(429)
    expect(await second.json()).toEqual({ ok: false, error: 'A Procore sync is already running for you.' })
    release()
    expect((await first).status).toBe(200)
  })

  it('allows 30 syncs per user per hour', async () => {
    const base = await start({ procore: fakeProcore() })
    for (let i = 0; i < 30; i++) expect((await post(base)).status).toBe(200)
    const res = await post(base)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toMatch(/^\d+$/)
    expect(await res.json()).toEqual({ ok: false, error: 'You have reached the limit of 30 Procore syncs per hour. Try again later.' })
  })
})

describe('GET /api/procore/project', () => {
  function withProject(projectNumber: string | null | (() => never)) {
    const client: ProcoreClient = {
      companyId: '42',
      getAll: vi.fn() as unknown as ProcoreClient['getAll'],
      get: vi.fn(async (path: string, query: Record<string, string>) => {
        if (typeof projectNumber === 'function') projectNumber()
        return { id: 7, project_number: projectNumber, path, query }
      }) as unknown as ProcoreClient['get'],
    }
    return client
  }
  const get = (base: string, q: string, token = 'good-token') =>
    fetch(`${base}/api/procore/project${q}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })

  it('needs a signed-in user and numeric ids', async () => {
    const base = await start({ procore: withProject('BKK-03') })
    expect((await get(base, '?company=42&project=7', '')).status).toBe(401)
    expect((await get(base, '?company=abc&project=7')).status).toBe(400)
    expect((await get(base, '?company=42')).status).toBe(400)
  })

  it('says when Procore is not set up', async () => {
    const base = await start({ procore: null })
    const res = await get(base, '?company=42&project=7')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ code: null, reason: 'not-configured' })
  })

  it('refuses another company', async () => {
    const base = await start({ procore: withProject('BKK-03') })
    expect(await (await get(base, '?company=99&project=7')).json()).toEqual({ code: null, reason: 'other-company' })
  })

  it('matches the project number to a listed project', async () => {
    const procore = withProject('BKK-03')
    const base = await start({ procore })
    expect(await (await get(base, '?company=42&project=7')).json()).toEqual({ code: 'BKK-03' })
    expect(vi.mocked(procore.get).mock.calls[0].slice(0, 2)).toEqual(['/rest/v1.0/projects/7', { company_id: '42', view: 'minimal' }])
  })

  it('says when Procore has no project number', async () => {
    const base = await start({ procore: withProject(null) })
    expect(await (await get(base, '?company=42&project=7')).json()).toEqual({ code: null, reason: 'no-match' })
  })

  it('does not match a project the caller cannot read', async () => {
    const base = await start({ procore: withProject('XYZ-99') })
    expect(await (await get(base, '?company=42&project=7')).json()).toEqual({ code: null, reason: 'no-match' })
  })

  it('answers procore-error when Procore fails', async () => {
    const base = await start({
      procore: withProject(() => {
        throw new ProcoreError('Procore is busy; try again in a minute.')
      }),
    })
    const res = await get(base, '?company=42&project=7')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ code: null, reason: 'no-match' })
  })
})

describe('GET /api/procore/project: limits (review)', () => {
  it('lets one user look up 60 projects an hour, then answers without asking Procore', async () => {
    const get = vi.fn(async () => ({ id: 7, project_number: 'BKK-03' }))
    const procore = { companyId: '42', getAll: vi.fn(), get } as unknown as ProcoreClient
    const base = await start({ procore })
    const ask = () => fetch(`${base}/api/procore/project?company=42&project=7`, { headers: { Authorization: 'Bearer good-token' } })
    for (let i = 0; i < 60; i++) expect(await (await ask()).json()).toEqual({ code: 'BKK-03' })
    const res = await ask()
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toMatch(/^\d+$/)
    expect(get).toHaveBeenCalledTimes(60)
  })
})

describe('GET /api/procore/project: review fixes', () => {
  it('matches a project number Procore sends as a number', async () => {
    const procore = { companyId: '42', getAll: vi.fn(), get: vi.fn(async () => ({ id: 7, project_number: 1234 })) } as unknown as ProcoreClient
    const base = await start({ procore }, async () => ({ ...OPTIONS, projects: [{ code: '1234', name: 'Numbered', isProgram: false, projectType: 'data-centre', inProcore: true }] }))
    const res = await fetch(`${base}/api/procore/project?company=42&project=7`, { headers: { Authorization: 'Bearer good-token' } })
    expect(await res.json()).toEqual({ code: '1234' })
  })
})
