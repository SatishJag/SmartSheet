// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ProcoreError, type ProcoreClient } from './procore'
import { committedForProject, parseCommittedRequest, sumByCostCode } from './procoreSync'

describe('parseCommittedRequest', () => {
  it('parses a valid request', () => {
    expect(parseCommittedRequest({ projects: [{ code: ' BKK-03 ', costCodes: [' chl', 'GEN', 'CHL'] }] })).toEqual({
      ok: true,
      value: { projects: [{ code: 'BKK-03', costCodes: ['CHL', 'GEN'] }] },
    })
  })

  it('refuses what it cannot sync', () => {
    const bad = (body: unknown) => parseCommittedRequest(body).ok
    expect(bad(null)).toBe(false)
    expect(bad([])).toBe(false)
    expect(bad({ projects: [] })).toBe(false)
    expect(bad({ projects: [{ costCodes: ['CHL'] }] })).toBe(false)
    expect(bad({ projects: [{ code: 'A', costCodes: 'CHL' }] })).toBe(false)
    expect(bad({ projects: [{ code: 'A', costCodes: [] }] })).toBe(false)
    expect(bad({ projects: [{ code: 'A', costCodes: ['X'.repeat(21)] }] })).toBe(false)
    expect(bad({ projects: Array.from({ length: 6 }, (_, i) => ({ code: `P${i}`, costCodes: ['CHL'] })) })).toBe(false)
    expect(bad({ projects: [{ code: 'A', costCodes: Array.from({ length: 30 }, (_, i) => `C${i}`) }, { code: 'B', costCodes: Array.from({ length: 21 }, (_, i) => `C${i}`) }] })).toBe(false)
    const result = parseCommittedRequest({ projects: [] })
    expect(!result.ok && result.error).toMatch(/project/)
  })
})

describe('sumByCostCode', () => {
  it('sums string and null amounts in cents', () => {
    expect(
      sumByCostCode([
        { amount: '1250000.50', cost_code: { code: 'chl' } },
        { amount: 100.25, cost_code: { code: 'CHL ' } },
        { amount: null, cost_code: { code: 'CHL' } },
        { amount: '5', cost_code: null },
        { amount: 'n/a', cost_code: { code: 'GEN' } },
      ]),
    ).toEqual(
      new Map([
        ['CHL', 125010075],
        ['GEN', 0],
      ]),
    )
  })
})

/** A fake client answering by path; records each call. */
function fakeClient(routes: Record<string, unknown[] | (() => never)>) {
  const calls: { path: string; query: Record<string, string> }[] = []
  const client: ProcoreClient = {
    companyId: '42',
    get: vi.fn() as unknown as ProcoreClient['get'],
    getAll: vi.fn(async <T,>(path: string, query: Record<string, string>) => {
      calls.push({ path, query })
      const r = routes[path]
      if (typeof r === 'function') r()
      if (!r) throw new Error(`unexpected ${path}`)
      return r as T[]
    }) as unknown as ProcoreClient['getAll'],
  }
  return { client, calls }
}

const PROJECT = [{ id: 7, project_number: 'BKK-03', name: 'Bangkok 3' }]

describe('committedForProject', () => {
  it('totals a project from counted commitments only', async () => {
    const { client, calls } = fakeClient({
      '/rest/v1.1/projects': PROJECT,
      '/rest/v1.0/work_order_contracts': [
        { id: 1, status: 'Approved' },
        { id: 2, status: 'Draft' },
        { id: 3, status: 'complete' },
        { id: 4, status: 'Approved', deleted_at: '2026-11-01T00:00:00Z' },
      ],
      '/rest/v1.0/purchase_order_contracts': [
        { id: 5, status: 'Received' },
        { id: 6, status: 'Submitted' },
      ],
      '/rest/v1.0/work_order_contracts/1/line_items': [{ amount: '1000000', cost_code: { code: 'CHL' } }],
      '/rest/v1.0/work_order_contracts/3/line_items': [{ amount: '250000.5', cost_code: { code: 'chl' } }],
      '/rest/v1.0/purchase_order_contracts/5/line_items': [{ amount: '42', cost_code: { code: 'GEN' } }],
      '/rest/v1.0/cost_codes': [{ code: 'CHL' }, { code: 'GEN' }, { code: 'TRF' }],
    })
    expect(await committedForProject(client, 'BKK-03', ['CHL', 'GEN', 'TRF', 'ELE'])).toEqual({
      code: 'BKK-03',
      status: 'ok',
      costCodes: [
        { code: 'CHL', committed: 1250000.5, awarded: true, known: true },
        { code: 'GEN', committed: 42, awarded: true, known: true },
        { code: 'TRF', committed: 0, awarded: false, known: true },
        { code: 'ELE', committed: 0, awarded: false, known: false },
      ],
    })
    expect(calls[0]).toEqual({ path: '/rest/v1.1/projects', query: { company_id: '42', 'filters[project_number]': 'BKK-03', 'filters[by_status]': 'All' } })
    const fetched = calls.map((c) => c.path)
    for (const id of [2, 4]) expect(fetched).not.toContain(`/rest/v1.0/work_order_contracts/${id}/line_items`)
    expect(fetched).not.toContain('/rest/v1.0/purchase_order_contracts/6/line_items')
    expect(calls.filter((c) => c.path !== '/rest/v1.1/projects').every((c) => c.query.project_id === '7')).toBe(true)
  })

  it('matches the project number exactly', async () => {
    const { client, calls } = fakeClient({ '/rest/v1.1/projects': [{ id: 8, project_number: 'BKK-03A' }] })
    expect(await committedForProject(client, 'BKK-03', ['CHL'])).toEqual({ code: 'BKK-03', status: 'not-found' })
    expect(calls).toHaveLength(1)
  })

  it('passes ProcoreError through', async () => {
    const { client } = fakeClient({
      '/rest/v1.1/projects': PROJECT,
      '/rest/v1.0/work_order_contracts': () => {
        throw new ProcoreError('Procore is busy; try again in a minute.')
      },
    })
    await expect(committedForProject(client, 'BKK-03', ['CHL'])).rejects.toEqual(new ProcoreError('Procore is busy; try again in a minute.'))
  })
})

describe('committedForProject: currencies', () => {
  const routes = (lines: Record<string, unknown[]>) =>
    fakeClient({
      '/rest/v1.1/projects': PROJECT,
      '/rest/v1.0/work_order_contracts': [{ id: 1, status: 'Approved' }],
      '/rest/v1.0/purchase_order_contracts': [{ id: 5, status: 'Approved' }],
      '/rest/v1.0/work_order_contracts/1/line_items': lines.wo,
      '/rest/v1.0/purchase_order_contracts/5/line_items': lines.po,
      '/rest/v1.0/cost_codes': [{ code: 'CHL' }, { code: 'GEN' }],
    })

  it('refuses to add up one cost code’s commitments in different currencies', async () => {
    const { client } = routes({
      wo: [{ amount: '100000', cost_code: { code: 'CHL' }, currency_configuration: { currency_iso_code: 'THB' } }],
      po: [{ amount: '100000', cost_code: { code: 'CHL' }, currency_configuration: { currency_iso_code: 'USD' } }],
    })
    await expect(committedForProject(client, 'BKK-03', ['CHL'])).rejects.toEqual(
      new ProcoreError('CHL on BKK-03 has commitments in more than one currency (THB, USD); the sync can’t add them up.'),
    )
  })

  it('adds up one currency, and ignores currencies on cost codes not asked for', async () => {
    const { client } = routes({
      wo: [
        { amount: '100', cost_code: { code: 'CHL' }, currency_configuration: { currency_iso_code: 'USD' } },
        { amount: '7', cost_code: { code: 'GEN' }, currency_configuration: { currency_iso_code: 'THB' } },
      ],
      po: [
        { amount: '50', cost_code: { code: 'CHL' }, currency_configuration: { currency_iso_code: 'usd' } },
        { amount: '1', cost_code: { code: 'CHL' } },
        { amount: '9', cost_code: { code: 'GEN' }, currency_configuration: { currency_iso_code: 'USD' } },
      ],
    })
    const result = await committedForProject(client, 'BKK-03', ['CHL'])
    expect(result).toEqual({ code: 'BKK-03', status: 'ok', costCodes: [{ code: 'CHL', committed: 151, awarded: true, known: true }] })
  })
})
