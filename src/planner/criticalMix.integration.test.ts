// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSupabaseLikeDb, roles } from '../db/supabaseTestDb'
import { defaultCalendar } from '../engine/calendar'
import { schedule } from '../engine/schedule'
import { toSchedInput } from '../store/scheduleInput'
import { planBackward } from './backward'
import { buildHistoryDraft } from './historyDraft'
import { buildSheetFromDraft } from './sheetFromDraft'
import type { CatalogActivity, HistorySummary, PlanRequest } from './types'
import { validateDraft } from './validateDraft'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

/**
 * Critical and non-critical work in a drafted plan, on the real seeded catalogs (migrations
 * 0001-0013 in a Supabase-like Postgres): the LLE plan has activities with float, and every
 * schedule type drafts a valid plan that lands on the required date.
 */
const USER = '11111111-1111-1111-1111-111111111111'
let db: PGlite

beforeAll(async () => {
  db = await createSupabaseLikeDb()
  await roles(db).asUser(USER)
}, 60_000)
afterAll(async () => {
  await db.close()
}, 60_000)

async function catalog(type: string): Promise<CatalogActivity[]> {
  const r = await db.query<{ code: string; name: string; phase: string; sequence: number; default_links: CatalogActivity['defaultLinks']; default_days: number; is_target: boolean }>(
    `select code, name, phase, sequence, default_links, default_days, is_target from activity_catalog where schedule_type = $1 order by sequence`,
    [type],
  )
  return r.rows.map((row) => ({
    scheduleType: type,
    code: row.code,
    name: row.name,
    phase: row.phase,
    sequence: row.sequence,
    defaultLinks: row.default_links.map((l) => ({ from: l.from, type: l.type, lagDays: l.lagDays ?? 0 })),
    defaultDays: row.default_days,
    isTarget: row.is_target,
  }))
}

async function summary(type: string, equipment: string | null): Promise<HistorySummary> {
  const r = await db.query<{ s: HistorySummary }>(`select planner_history_summary($1, $2) as s`, [type, equipment])
  return r.rows[0].s
}

const REQUIRED = '2027-09-15'

async function draftFor(type: string, equipmentType: string) {
  const cat = await catalog(type)
  const history = await summary(type, equipmentType)
  const request: PlanRequest = { scheduleType: type, equipmentType, equipmentName: `${equipmentType} for block A`, requiredDate: REQUIRED }
  const draft = buildHistoryDraft({ request, catalog: cat, history, assumptions: [] })
  expect(validateDraft(draft, { catalog: cat, stats: history.stats }).ok, type).toBe(true)
  return { draft, plan: planBackward(draft, defaultCalendar, '2026-11-16') }
}

describe('critical and non-critical work', () => {
  it.each(['Power transformer', 'HV switchgear', 'Chiller', 'Diesel generator', 'Elevator'])('an LLE plan for %s has both', async (equipmentType) => {
    const { plan } = await draftFor('lle-procurement', equipmentType)
    const critical = plan.activities.filter((a) => a.critical).map((a) => a.code)
    const other = plan.activities.filter((a) => !a.critical)
    expect(critical.length).toBeGreaterThan(0)
    expect(other.map((a) => a.code).sort()).toEqual(['FATPREP', 'FRTFWD', 'SHIPDOC'])
    for (const a of other) expect(a.totalFloat, a.code).toBeGreaterThan(0)
    for (const a of plan.activities.filter((x) => x.critical)) expect(a.totalFloat, a.code).toBe(0)
    // The chain through manufacturing and the target is critical
    expect(critical).toEqual(expect.arrayContaining(['SPEC', 'AWARD', 'MFG', 'FAT', 'RELEASE', 'SHIP', 'ONSITE']))
  })

  it('the sheet the planner creates shows the same split in the grid engine', async () => {
    const { draft, plan } = await draftFor('lle-procurement', 'Power transformer')
    const sheet = buildSheetFromDraft(draft, plan, USER, defaultCalendar)
    const input = toSchedInput(sheet)!
    const result = schedule(input.rows, input.deps, input.calendar)
    expect(result.errors).toEqual([])
    expect(plan.criticalLinks.length).toBeGreaterThan(0)
    // Links out of non-critical work are not critical links
    expect(plan.criticalLinks).not.toContain('SHIPDOC>RELEASE')
  })

  it.each([
    ['lle-procurement', 'Power transformer'],
    ['materials-procurement', 'Rebar'],
    ['other-equipment-procurement', 'Cooling skid'],
    ['subcontract-procurement', 'Raised floor'],
    ['consultant-appointment', 'Commissioning agent'],
  ])('%s drafts a valid plan that lands on the required date', async (type, equipmentType) => {
    const { plan, draft } = await draftFor(type, equipmentType)
    expect(plan.activities.find((a) => a.code === draft.targetCode)!.end).toBe(REQUIRED)
    expect(plan.mustStartBy < REQUIRED).toBe(true)
  })
})
