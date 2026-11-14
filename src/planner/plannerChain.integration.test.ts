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
 * The whole planner chain on the real sample history, with nothing faked but the network:
 * migrations 0001-0005 in a Supabase-like Postgres, read as a signed-in user (RLS applies)
 * -> the server's history-only draft -> the server's validation -> the client's backward planning
 * -> the sheet the client would save, rescheduled by the sheet engine.
 */
const USER = '11111111-1111-1111-1111-111111111111'
const LLE = 'lle-procurement'
let db: PGlite

beforeAll(async () => {
  db = await createSupabaseLikeDb()
  await roles(db).asUser(USER)
}, 60_000)

afterAll(async () => {
  await db.close()
}, 60_000)

async function catalog(): Promise<CatalogActivity[]> {
  const r = await db.query<{
    code: string
    name: string
    phase: string
    sequence: number
    default_links: CatalogActivity['defaultLinks']
    default_days: number
    is_target: boolean
  }>(`select code, name, phase, sequence, default_links, default_days, is_target from activity_catalog where schedule_type = $1 order by sequence`, [LLE])
  return r.rows.map((row) => ({
    scheduleType: LLE,
    code: row.code,
    name: row.name,
    phase: row.phase,
    sequence: row.sequence,
    defaultLinks: row.default_links.map((l) => ({ from: l.from, type: l.type, lagDays: l.lagDays ?? 0 })),
    defaultDays: row.default_days,
    isTarget: row.is_target,
  }))
}

async function summary(equipment: string | null): Promise<HistorySummary> {
  const r = await db.query<{ s: HistorySummary }>(`select planner_history_summary($1, $2) as s`, [LLE, equipment])
  return r.rows[0].s
}

async function equipmentTypes(): Promise<string[]> {
  const r = await db.query<{ equipment_type: string }>(
    `select equipment_type from planner_equipment_types where schedule_type = $1 order by 1`,
    [LLE],
  )
  return r.rows.map((x) => x.equipment_type)
}

describe('planner chain on the LLE sample history', () => {
  it('every equipment type yields a valid draft that lands exactly on the required date', async () => {
    const cat = await catalog()
    const types = await equipmentTypes()
    expect(types.length).toBeGreaterThanOrEqual(5)
    for (const equipmentType of types) {
      const history = await summary(equipmentType)
      expect(history.projectCount, equipmentType).toBeGreaterThan(0)
      expect(history.sampleOnly).toBe(true)
      const request: PlanRequest = {
        scheduleType: LLE,
        equipmentType,
        equipmentName: `${equipmentType} for block A`,
        requiredDate: '2027-09-15', // a Wednesday
      }
      const draft = buildHistoryDraft({ request, catalog: cat, history, assumptions: [] })
      const checked = validateDraft(draft, { catalog: cat, stats: history.stats })
      expect(checked.ok ? [] : checked.errors, equipmentType).toEqual([])

      const plan = planBackward(draft, defaultCalendar, '2026-11-16')
      const target = plan.activities.find((a) => a.code === draft.targetCode)!
      expect(target.end, equipmentType).toBe('2027-09-15')
      expect(plan.mustStartBy < '2027-09-15').toBe(true)

      // The sheet the planner approves reschedules to the same dates in the grid engine.
      const sheet = buildSheetFromDraft(draft, plan, USER, defaultCalendar)
      const input = toSchedInput(sheet)!
      const result = schedule(input.rows, input.deps, input.calendar)
      expect(result.errors, equipmentType).toEqual([])
      const ends = Object.values(result.byRow).map((s) => s.end).sort()
      expect(ends[ends.length - 1], equipmentType).toBe('2027-09-15')
    }
  })

  it('a required date already too close is flagged late, with a realistic earliest finish', async () => {
    const cat = await catalog()
    const history = await summary('Power transformer')
    const request: PlanRequest = {
      scheduleType: LLE,
      equipmentType: 'Power transformer',
      equipmentName: '400 MVA transformer',
      requiredDate: '2027-01-15',
    }
    const draft = buildHistoryDraft({ request, catalog: cat, history, assumptions: [] })
    const plan = planBackward(draft, defaultCalendar, '2026-11-16')
    expect(plan.feasibility.lateByWorkingDays).toBeGreaterThan(0)
    expect(plan.feasibility.message).toMatch(/should have started/)
  })
})
