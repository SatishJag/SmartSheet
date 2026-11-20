import { describe, expect, it } from 'vitest'
import { defaultCalendar } from '../engine/calendar'
import { schedule } from '../engine/schedule'
import { planBackward } from '../planner/backward'
import { buildSheetFromDraft } from '../planner/sheetFromDraft'
import { toSchedInput } from '../store/scheduleInput'
import { given } from './__fixtures__/durations'
import { draftPlan } from './backSchedule'
import { PROCUREMENT_TYPES, procurementType } from './catalog'
import { planToDraft } from './toDraft'

const TODAY = '2026-11-16'
const NEED = '2027-09-15' // a Wednesday
const type = (code: string) => procurementType(code)!
const req = { equipmentType: 'Chiller', equipmentName: '1,500 TR chiller' }

/** Equipment types run on template windows; the others need durations given. */
const planFor = (code: string, need = NEED, extra: Parameters<typeof draftPlan>[3] = {}) =>
  draftPlan(type(code), need, defaultCalendar, type(code).kind === 'equipment' ? extra : { durations: given(code), ...extra })

describe('a procurement plan as the planner draft', () => {
  it.each(PROCUREMENT_TYPES.map((t) => [t.code, t] as const))('%s goes through the planner and lands on the need date', (code) => {
    const plan = planFor(code)
    const draft = planToDraft(plan, req)
    expect(draft.targetCode).toBe(plan.activities.find((a) => a.anchor)!.code)
    expect(draft.request).toMatchObject({ scheduleType: code, requiredDate: NEED })

    const planned = planBackward(draft, defaultCalendar, TODAY)
    expect(planned.activities.find((a) => a.code === draft.targetCode)!.end).toBe(NEED)
    // The planner's dates agree with the procurement back-scheduler's
    expect(planned.mustStartBy).toBe(plan.startBy)
    expect(planned.projectEnd).toBe(plan.finishOn)

    // The sheet it creates reschedules, in the grid engine, to the same finish
    const sheet = buildSheetFromDraft(draft, planned, 'user-1', defaultCalendar)
    const input = toSchedInput(sheet)!
    const result = schedule(input.rows, input.deps, input.calendar)
    expect(result.errors).toEqual([])
    const ends = Object.values(result.byRow).map((s) => s.end).sort()
    expect(ends[ends.length - 1]).toBe(plan.finishOn)
  })

  it('shows critical and non-critical work for equipment, where manufacturing has work alongside it', () => {
    const planned = planBackward(planToDraft(planFor('CHL'), req), defaultCalendar, TODAY)
    const off = planned.activities.filter((a) => !a.critical).map((a) => a.code)
    // FAT scripts, the freight forwarder and the shipping documents do not drive the delivery
    expect(off).toEqual(expect.arrayContaining(['CHL.3', 'CHL.5', 'CHL.6']))
    for (const a of planned.activities.filter((x) => !x.critical)) expect(a.totalFloat, a.code).toBeGreaterThan(0)
    expect(planned.activities.filter((a) => a.critical).map((a) => a.code)).toEqual(expect.arrayContaining(['CHL.2', 'CHL.4', 'CHL.7']))
  })

  it('shows a chain as all critical, as in the source schedules', () => {
    const planned = planBackward(planToDraft(planFor('SUB'), req), defaultCalendar, TODAY)
    expect(planned.activities.every((a) => a.critical)).toBe(true)
  })

  it('carries one link per catalogue link, and bridges the logic across a left-out step', () => {
    const full = planToDraft(planFor('CHL'), req)
    expect(full.links).toHaveLength(type('CHL').activities.reduce((n, a) => n + a.predecessors.length, 0))
    const noScripts = planToDraft(planFor('CHL', NEED, { exclude: ['CHL.3'] }), req)
    expect(noScripts.activities.find((a) => a.code === 'CHL.3')).toBeUndefined()
    expect(noScripts.links.filter((l) => l.to === 'CHL.4').map((l) => l.from).sort()).toEqual(['CHL.15', 'CHL.2'])
  })

  it('writes elapsed steps in working days, and says where each duration came from', () => {
    const draft = planToDraft(planFor('MAT', NEED, { durations: { ...given('MAT'), 'MAT.rfq': 12 } }), req)
    const by = new Map(draft.activities.map((a) => [a.code, a]))
    expect(by.get('MAT.source')!.durationDays).toBe(43) // 60 calendar days -> ceil(60 * 5 / 7)
    expect(by.get('MAT.rfq')).toMatchObject({ durationDays: 12, basis: 'adjusted', reason: 'Set by the planner.' })
    const chl = planToDraft(planFor('CHL'), req)
    expect(chl.activities.every((a) => a.basis === 'default' && /Template window/.test(a.reason))).toBe(true)
  })

  it('uses history as the planner’s median basis', () => {
    const plan = draftPlan(type('CHL'), NEED, defaultCalendar, { evidence: { history: { 'CHL.2': [40, 50, 60] } } })
    const a = planToDraft(plan, req).activities.find((x) => x.code === 'CHL.2')!
    expect(a).toMatchObject({ durationDays: 50, basis: 'p50', reason: 'Median of 3 completed activities.' })
  })

  it('refuses a plan with a duration still missing', () => {
    const plan = draftPlan(type('SUB'), NEED, defaultCalendar)
    expect(() => planToDraft(plan, req)).toThrow(/need a duration/)
  })
})
