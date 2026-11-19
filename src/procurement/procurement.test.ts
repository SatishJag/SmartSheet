import { describe, expect, it } from 'vitest'
import { defaultCalendar } from '../engine/calendar'
import type { Calendar } from '../engine/types'
import { anchorOf, backSchedule, draftPlan, workingLength, type DurationedActivity } from './backSchedule'
import { medianDays, suggestDuration } from './durations'
import { PROCUREMENT_TYPES, procurementType } from './catalog'
import { EQUIPMENT_TYPES, stageWindow } from './equipment'
import { STARTER_TYPES } from './starters'
import { given } from './__fixtures__/durations'
import { planToDraft } from './toDraft'

const type = (code: string) => procurementType(code)!
const holidays: Calendar = { ...defaultCalendar, nonWorkingDates: ['2027-04-02', '2027-05-03', '2027-05-17'] }

describe('equipment catalogue', () => {
  it('has the eight long-lead types with their activity counts', () => {
    expect(EQUIPMENT_TYPES.map((t) => [t.code, t.activities.length])).toEqual([
      ['GEN', 18], ['UPS', 18], ['CHL', 18], ['MV', 18], ['TRF', 19], ['FWU', 18], ['CRAC', 18], ['FAHU', 18],
    ])
  })

  it.each(EQUIPMENT_TYPES.map((t) => [t.code, t] as const))('%s has unique codes and only internal predecessors', (_c, t) => {
    const codes = new Set(t.activities.map((a) => a.code))
    expect(codes.size).toBe(t.activities.length)
    for (const a of t.activities) {
      expect(a.code.startsWith(`${t.code}.`)).toBe(true)
      for (const p of a.predecessors) expect(codes.has(p), `${a.code} -> ${p}`).toBe(true)
      expect(stageWindow(a.stage), a.stage).toBeDefined()
    }
    expect(codes.has(anchorOf(t))).toBe(true)
  })

  it('anchors on receipt, and transformers (which have none) on local handling', () => {
    expect(anchorOf(type('CHL'))).toBe('CHL.7')
    expect(type('TRF').activities.some((a) => a.stage === 'Receipt')).toBe(false)
    expect(anchorOf(type('TRF'))).toBe('TRF.12')
  })
})

describe('durations', () => {
  const kickoff = type('CHL').activities[0]
  it('prefers history, then earlier plans, then similar work, then the template window', () => {
    expect(suggestDuration(kickoff, { history: { [kickoff.code]: [4, 6, 8] }, plans: { [kickoff.code]: [9] } })).toEqual({ days: 6, basis: 'history', samples: 3 })
    expect(suggestDuration(kickoff, { plans: { [kickoff.code]: [9] }, similar: { Kickoff: [1] } })).toEqual({ days: 9, basis: 'plans', samples: 1 })
    expect(suggestDuration(kickoff, { similar: { Kickoff: [1, 2] } })).toEqual({ days: 2, basis: 'similar', samples: 2 })
    expect(suggestDuration(kickoff)).toEqual({ days: 3, basis: 'template', samples: 0 })
    expect(suggestDuration(kickoff, { history: { [kickoff.code]: [] } }).basis).toBe('template')
  })

  it('rounds the median half to even, like the Procurement app', () => {
    expect([medianDays([2, 3]), medianDays([3, 4]), medianDays([1, 2, 3]), medianDays([4, 4, 5, 9])]).toEqual([2, 4, 2, 4])
  })
})

describe('backSchedule', () => {
  it('works chillers back from the need date (matches the Procurement app)', () => {
    const plan = draftPlan(type('CHL'), '2027-06-30', defaultCalendar)
    expect(plan.startBy).toBe('2027-01-25')
    expect(plan.awardBy).toBe('2027-01-25') // no award step in this type: procurement start
    expect(plan.finishOn).toBe('2027-07-28')
    expect(plan.missing).toEqual([])
    const at = (suffix: string) => plan.activities.find((a) => a.code === `CHL.${suffix}`)!
    expect([at('7').start, at('7').finish]).toEqual(['2027-06-29', '2027-06-30'])
    expect([at('4').start, at('4').finish]).toEqual(['2027-04-26', '2027-05-07']) // FAT
    expect([at('2').start, at('2').finish]).toEqual(['2027-02-22', '2027-04-23']) // manufacturing, 45 days
    expect(at('7').anchor).toBe(true)
    // Handover and site acceptance run forward from the receipt
    expect(['13', 'SAT1', 'SAT2', 'SAT3'].map((s) => at(s).afterNeed)).toEqual([true, true, true, true])
    expect(at('SAT3').finish).toBe('2027-07-28')
    expect(at('12').afterNeed).toBe(false)
    expect(plan.activities.every((a) => a.basis === 'template')).toBe(true)
  })

  // Parity with backend/app/plans.py `schedule()` (template durations, three holidays).
  it.each([
    ['GEN', '2027-06-30', '2027-01-20', '2027-07-28'],
    ['UPS', '2027-12-15', '2027-07-12', '2028-01-12'],
    ['CHL', '2027-06-30', '2027-01-20', '2027-07-28'],
    ['MV', '2027-12-15', '2027-07-12', '2028-01-12'],
    ['FWU', '2027-06-30', '2027-01-20', '2027-07-28'],
    ['CRAC', '2027-12-15', '2027-07-12', '2028-01-12'],
    ['FAHU', '2027-06-30', '2027-01-20', '2027-07-28'],
    // Transformers are anchored on local handling here (the Procurement app anchors them on SAT closeout).
    ['TRF', '2027-06-30', '2027-01-22', '2027-08-02'],
    ['TRF', '2027-12-15', '2027-07-14', '2028-01-17'],
  ])('%s needed %s starts %s and finishes %s with holidays', (code, need, startBy, finishOn) => {
    const plan = draftPlan(type(code), need, holidays)
    expect([plan.startBy, plan.finishOn]).toEqual([startBy, finishOn])
  })

  it('rolls a need date on a non-working day back to the previous working day', () => {
    const plan = draftPlan(type('CHL'), '2027-07-03', defaultCalendar) // Saturday
    expect(plan.activities.find((a) => a.anchor)!.finish).toBe('2027-07-02')
  })

  it('uses given durations, leaves out optional steps and reports missing ones', () => {
    const base = draftPlan(type('CHL'), '2027-06-30', defaultCalendar)
    const longer = draftPlan(type('CHL'), '2027-06-30', defaultCalendar, { durations: { 'CHL.2': 60 } })
    expect(longer.activities.find((a) => a.code === 'CHL.2')!.basis).toBe('edited')
    expect(longer.startBy < base.startBy).toBe(true)
    const noFat = draftPlan(type('CHL'), '2027-06-30', defaultCalendar, { exclude: ['CHL.3'] })
    expect(noFat.activities.find((a) => a.code === 'CHL.3')!.included).toBe(false)
    expect(() => draftPlan(type('CHL'), '2027-06-30', defaultCalendar, { durations: { NOPE: 1 } })).toThrow(/no activity NOPE/)
  })

  const act = (code: string, duration: number | null, predecessors: string[] = [], extra: Partial<DurationedActivity> = {}): DurationedActivity => ({
    code, name: code, stage: 'Kickoff', owner: 'x', predecessors, duration, included: true, ...extra,
  })

  it('refuses logic with a loop', () => {
    expect(() => backSchedule([act('a', 1, ['b']), act('b', 1, ['a'])], 'a', '2027-06-30', defaultCalendar)).toThrow(/loop/)
  })

  it('converts elapsed steps at five working days per seven and gives unknown durations no time', () => {
    expect(workingLength({ duration: 14, included: true, elapsed: true })).toBe(10)
    expect(workingLength({ duration: 1, included: true, elapsed: true })).toBe(1)
    expect(workingLength({ duration: 0, included: true, elapsed: true })).toBe(0)
    expect(workingLength({ duration: null, included: true })).toBe(0)
    expect(workingLength({ duration: 5, included: false })).toBe(0)
    const r = backSchedule([act('a', 14, [], { elapsed: true }), act('b', 2, ['a'])], 'b', '2027-06-30', defaultCalendar)
    expect(r.startBy).toBe('2027-06-15') // 10 + 2 working days ending Wed 30 Jun
  })

  it('takes the award finish as the award date when a step is marked', () => {
    const r = backSchedule([act('tender', 5), act('award', 2, ['tender'], { award: true }), act('recv', 3, ['award'])], 'recv', '2027-06-30', defaultCalendar)
    expect(r.awardBy).toBe('2027-06-25')
    expect(r.startBy).toBe('2027-06-17')
  })
})

describe('materials, other equipment, subcontract and consultant', () => {
  it('are in the combined catalogue after the equipment types', () => {
    expect(STARTER_TYPES.map((t) => [t.code, t.name, t.kind, t.activities.length])).toEqual([
      ['MAT', 'Materials', 'general', 7], ['OEQ', 'Other equipment', 'general', 11], ['SUB', 'Subcontract', 'general', 9], ['CON', 'Consultant', 'general', 7],
    ])
    expect(PROCUREMENT_TYPES).toHaveLength(12)
    expect(PROCUREMENT_TYPES.slice(0, 8)).toEqual(EQUIPMENT_TYPES)
    expect(procurementType('SUB')!.name).toBe('Subcontract')
    expect(procurementType('NOPE')).toBeUndefined()
  })

  it.each(STARTER_TYPES.map((t) => [t.code, t] as const))('%s is a chain with one award step, an anchor and a phase for every step', (_c, t) => {
    const codes = new Set(t.activities.map((a) => a.code))
    expect(codes.size).toBe(t.activities.length)
    for (const a of t.activities) {
      expect(a.code.startsWith(`${t.code}.`)).toBe(true)
      for (const p of a.predecessors) expect(codes.has(p), `${a.code} -> ${p}`).toBe(true)
      expect(a.phase, a.code).toBeTruthy()
      expect(a.stage).toBe(a.name)
      expect(suggestDuration(a, { similar: { [a.stage]: [9] } }, 'general'), `${a.stage} must not pick up equipment durations`).toEqual({ days: null, basis: 'needed', samples: 0 })
    }
    expect(codes.has(anchorOf(t))).toBe(true)
    expect(t.activities.filter((a) => a.award)).toHaveLength(1)
    // The anchor is the last step, so the need date is when the work lands
    expect(anchorOf(t)).toBe(t.activities[t.activities.length - 1].code)
  })

  it('keeps the source flags: elapsed steps, optional steps, approvals and evidence', () => {
    const sub = type('SUB')
    const at = (c: string) => sub.activities.find((a) => a.code === `SUB.${c}`)!
    expect(sub.activities.filter((a) => a.optional).map((a) => a.code)).toEqual(['SUB.prequalify', 'SUB.negotiate'])
    expect(sub.activities.filter((a) => a.elapsed).map((a) => a.code)).toEqual(['SUB.tender', 'SUB.mobilise'])
    expect(at('award')).toMatchObject({ approver: 'Project Manager', evidence: ['Subcontract'], owner: 'Procurement Manager' })
    expect(type('CON').activities.find((a) => a.award)!.code).toBe('CON.appoint')
  })

  it('keeps the release conditions on "Release for manufacture", with one that can be waived', () => {
    const release = type('OEQ').activities.find((a) => a.code === 'OEQ.release')!
    expect(release.releaseConditions!.map((c) => [c.code, c.mandatory])).toEqual([
      ['effective_award', true], ['drawings_approved', true], ['deposit_confirmed', true], ['design_freeze', false], ['vendor_acknowledgement', true],
    ])
    expect(type('OEQ').activities.filter((a) => a.releaseConditions)).toHaveLength(1)
    const oeq = type('OEQ')
    expect(oeq.activities.filter((a) => a.optional).map((a) => a.code)).toEqual(['OEQ.fat', 'OEQ.customs'])
    expect(oeq.activities.filter((a) => a.elapsed).map((a) => a.code)).toEqual(['OEQ.tender', 'OEQ.manufacture', 'OEQ.ship', 'OEQ.customs'])
    expect(oeq.activities.find((a) => a.code === 'OEQ.fat')).toMatchObject({ approver: 'Quality Lead', evidence: ['FAT report'] })
    expect(anchorOf(oeq)).toBe('OEQ.receive_accept')
  })

  it('does not give the Customs step of other equipment the equipment Customs window', () => {
    const customs = type('OEQ').activities.find((a) => a.code === 'OEQ.customs')!
    expect(stageWindow('Customs')).toBeDefined() // the equipment stage of that name has one
    expect(draftPlan(type('OEQ'), '2027-06-30', defaultCalendar).activities.find((a) => a.code === customs.code)).toMatchObject({ duration: null, basis: 'needed' })
    expect(draftPlan(type('CHL'), '2027-06-30', defaultCalendar).activities.find((a) => a.stage === 'Customs')).toMatchObject({ duration: 5, basis: 'template' })
  })

  it('need a duration for every step: the source gives none', () => {
    for (const t of STARTER_TYPES) {
      const plan = draftPlan(t, '2027-06-30', defaultCalendar)
      expect(plan.missing).toHaveLength(t.activities.length)
      expect(plan.activities.every((a) => a.basis === 'needed' && a.duration === null)).toBe(true)
      expect(() => planToDraft(plan, { equipmentType: 'x', equipmentName: 'y' })).toThrow(/need a duration/)
    }
  })

  // Parity with backend/app/plans.py `schedule()` using the same durations and holidays.
  it.each([
    ['MAT', '2027-06-30', [], '2027-03-03', '2027-04-05'],
    ['MAT', '2027-12-15', [], '2027-08-23', '2027-09-22'],
    ['OEQ', '2027-06-30', [], '2026-07-31', '2026-10-13'],
    ['OEQ', '2027-06-30', ['OEQ.fat', 'OEQ.customs'], '2026-08-14', '2026-10-27'],
    ['OEQ', '2027-12-15', [], '2027-01-15', '2027-03-30'],
    ['OEQ', '2027-12-15', ['OEQ.fat', 'OEQ.customs'], '2027-01-29', '2027-04-14'],
    ['SUB', '2027-06-30', [], '2027-03-18', '2027-05-31'],
    ['SUB', '2027-06-30', ['SUB.prequalify', 'SUB.negotiate'], '2027-04-09', '2027-05-31'],
    ['SUB', '2027-12-15', [], '2027-09-07', '2027-11-15'],
    ['SUB', '2027-12-15', ['SUB.prequalify', 'SUB.negotiate'], '2027-09-28', '2027-11-15'],
    ['CON', '2027-06-30', [], '2027-05-11', '2027-06-22'],
    ['CON', '2027-12-15', [], '2027-10-27', '2027-12-07'],
  ])('%s needed %s without %j: start by %s, award by %s', (code, need, exclude, startBy, awardBy) => {
    const plan = draftPlan(type(code), need, holidays, { durations: given(code), exclude })
    expect(plan.missing).toEqual([])
    expect([plan.startBy, plan.awardBy, plan.finishOn]).toEqual([startBy, awardBy, need])
    expect(plan.activities.every((a) => !a.afterNeed)).toBe(true)
    expect(plan.activities.find((a) => a.anchor)!.finish).toBe(need)
  })
})
