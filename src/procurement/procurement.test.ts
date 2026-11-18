import { describe, expect, it } from 'vitest'
import { buildApp } from '../apps/build'
import { validateCell } from '../model/validate'
import { defaultCalendar } from '../engine/calendar'
import type { Calendar } from '../engine/types'
import { anchorOf, backSchedule, draftPlan, workingLength, type DurationedActivity } from './backSchedule'
import { medianDays, suggestDuration } from './durations'
import { EQUIPMENT_TYPES, STAGE_WINDOWS } from './equipment'
import { planPhases, planTemplate } from './toTemplate'

const type = (code: string) => EQUIPMENT_TYPES.find((t) => t.code === code)!
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
      expect(STAGE_WINDOWS[a.stage], a.stage).toBeDefined()
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

describe('plan to sheet', () => {
  const opts = (startDate: string) => ({ projectName: 'Chillers', client: null, startDate, ownerId: 'u1', withResources: true })

  it('builds a sheet whose receipt lands on the need date and whose links match the catalogue', () => {
    const plan = draftPlan(type('CHL'), '2027-06-30', defaultCalendar)
    const app = buildApp(planTemplate(plan), opts(plan.startBy))
    const sheet = app.sheets[0]
    const col = (t: string) => sheet.columns.find((c) => c.title === t)!.id
    const byName = new Map(sheet.rows.map((r) => [r.cells[col('Task')], r]))
    const receipt = byName.get('Receipt of equipment at site and quality clearance')!
    expect(receipt.cells[col('End')]).toBe('2027-06-30')
    expect(app.starts_at).toBe(plan.startBy)

    // The FAT waits for both the manufacturing monitoring and the FAT scripts
    const fat = byName.get('Execute FAT at vendor factory')!
    const preds = sheet.dependencies.filter((d) => d.successorId === fat.id).map((d) => sheet.rows.find((r) => r.id === d.predecessorId)!.cells[col('Task')])
    expect(preds.sort()).toEqual(['Biweekly manufacturing progress monitoring', 'Prepare FAT test scripts'])
    // One dependency per catalogue link
    const links = plan.activities.reduce((n, a) => n + a.predecessors.length, 0)
    expect(sheet.dependencies).toHaveLength(links)
    // Cells validate, and no task starts before the plan or ends after the last activity
    for (const r of sheet.rows) {
      for (const [colId, value] of Object.entries(r.cells)) {
        const c = sheet.columns.find((x) => x.id === colId)!
        const res = validateCell(c, String(value), { rowCount: sheet.rows.length, ownRowNumber: 1, hoursPerDay: 8, dependenciesEnabled: true })
        expect(res.ok, `${c.title} = ${String(value)}`).toBe(true)
      }
    }
    expect(app.ends_at).toBe(plan.finishOn)
  })

  it('books project roles but not the supplier', () => {
    const plan = draftPlan(type('GEN'), '2027-06-30', defaultCalendar)
    const tpl = planTemplate(plan)
    expect(tpl.roles).toContain('Logistics Coordinator')
    expect(tpl.roles).not.toContain('Supplier')
    expect(tpl.disciplines).toEqual(['Electrical'])
  })

  it('passes the logic of a left-out activity on to its successors', () => {
    const plan = draftPlan(type('CHL'), '2027-06-30', defaultCalendar, { exclude: ['CHL.3'] }) // FAT scripts
    const tasks = planPhases(plan).flatMap((p) => p.tasks)
    expect(tasks.find((t) => t.key === 'CHL.3')).toBeUndefined()
    expect(tasks.find((t) => t.key === 'CHL.4')!.after!.sort()).toEqual(['CHL.15', 'CHL.2']) // monitoring, and approval via the scripts
  })

  it('will not build a sheet while a duration is missing', () => {
    const plan = draftPlan(type('CHL'), '2027-06-30', defaultCalendar)
    plan.activities[0].duration = null
    plan.missing = [plan.activities[0].code]
    expect(() => planPhases(plan)).toThrow(/need a duration/)
  })

  it.each(EQUIPMENT_TYPES.map((t) => [t.code, t] as const))('%s builds a schedulable sheet', (_c, t) => {
    const plan = draftPlan(t, '2027-09-15', defaultCalendar)
    const app = buildApp(planTemplate(plan), opts(plan.startBy))
    expect(app.sheets[0].rows.length).toBe(plan.activities.length + planTemplate(plan).plan.length)
    expect(app.starts_at).toBe(plan.startBy)
  })
})
