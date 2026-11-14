import { describe, expect, it } from 'vitest'
import { defaultCalendar, isWorkingDay } from '../engine/calendar'
import { schedule } from '../engine/schedule'
import type { Calendar, DepType } from '../engine/types'
import { activity, link, lleDraft, makeDraft } from '../test/plannerFixtures'
import { assessFeasibility, daysToMinutes, planBackward, todayIso, uniqueLinks, workingDaysFrom } from './backward'
import type { DraftActivity, DraftLink } from './types'

// 2026-11-09 is a Monday. Calendar: Mon-Fri, 8h days.
const cal = defaultCalendar
const TODAY = '2026-11-14' // a Saturday

const byCode = (plan: ReturnType<typeof planBackward>) => Object.fromEntries(plan.activities.map((a) => [a.code, a]))

describe('workingDaysFrom', () => {
  it('counts working days between two dates, signed', () => {
    expect(workingDaysFrom(cal, '2026-11-09', '2026-11-09')).toBe(0)
    expect(workingDaysFrom(cal, '2026-11-09', '2026-11-13')).toBe(4)
    expect(workingDaysFrom(cal, '2026-11-13', '2026-11-16')).toBe(1) // Fri -> Mon
    expect(workingDaysFrom(cal, '2026-11-16', '2026-11-13')).toBe(-1)
    expect(workingDaysFrom(cal, '2026-11-14', '2026-11-16')).toBe(1) // Sat -> Mon
  })

  it('skips non-working dates', () => {
    const holiday: Calendar = { ...cal, nonWorkingDates: ['2026-11-11'] }
    expect(workingDaysFrom(holiday, '2026-11-09', '2026-11-13')).toBe(3)
  })
})

describe('todayIso', () => {
  it('formats the local date', () => {
    expect(todayIso(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
})

describe('planBackward: exact dates', () => {
  it('FS chain: the target finishes on the required date', () => {
    const draft = makeDraft([activity('A', 5), activity('T', 5)], [link('A', 'T')], 'T', '2026-12-04')
    const plan = planBackward(draft, cal, TODAY)
    const a = byCode(plan)
    expect(a.T).toMatchObject({ start: '2026-11-30', end: '2026-12-04', isTarget: true, isRoot: false })
    expect(a.A).toMatchObject({ start: '2026-11-23', end: '2026-11-27', isTarget: false, isRoot: true })
    expect(plan.targetFinish).toBe('2026-12-04')
    expect(plan.dateNote).toBeNull()
    expect(plan.mustStartBy).toBe('2026-11-23')
    expect(plan.projectEnd).toBe('2026-12-04')
    expect(plan.iterations).toBeLessThanOrEqual(2)
  })

  it('a non-working required date moves the finish to the working day before, and says so', () => {
    const draft = makeDraft([activity('A', 5), activity('T', 5)], [link('A', 'T')], 'T', '2026-12-06') // Sunday
    const plan = planBackward(draft, cal, TODAY)
    expect(plan.targetFinish).toBe('2026-12-04')
    expect(byCode(plan).T.end).toBe('2026-12-04')
    expect(plan.dateNote).toBe('2026-12-06 is not a working day, so the plan finishes on the working day before, 2026-12-04.')
  })

  it('a non-working date in the calendar is skipped too', () => {
    const holiday: Calendar = { ...cal, nonWorkingDates: ['2026-12-04', '2026-12-01'] }
    const draft = makeDraft([activity('A', 5), activity('T', 3)], [link('A', 'T')], 'T', '2026-12-04')
    const plan = planBackward(draft, holiday, TODAY)
    const a = byCode(plan)
    expect(plan.targetFinish).toBe('2026-12-03')
    expect(a.T).toMatchObject({ start: '2026-11-30', end: '2026-12-03' }) // Mon, (Tue off), Wed, Thu
  })

  it('a milestone target finishes (and starts) on the required date', () => {
    const draft = makeDraft([activity('A', 5), activity('T', 0)], [link('A', 'T')], 'T', '2026-12-04')
    const plan = planBackward(draft, cal, TODAY)
    const a = byCode(plan)
    expect(a.T).toMatchObject({ start: '2026-12-04', end: '2026-12-04' })
    expect(a.A).toMatchObject({ start: '2026-11-27', end: '2026-12-03' })
  })

  it('FS lag and lead shift the chain by working days', () => {
    const lag = planBackward(makeDraft([activity('A', 5), activity('T', 5)], [link('A', 'T', 'FS', 2)], 'T', '2026-12-04'), cal, TODAY)
    expect(byCode(lag).A).toMatchObject({ start: '2026-11-19', end: '2026-11-25' })
    const lead = planBackward(makeDraft([activity('A', 5), activity('T', 5)], [link('A', 'T', 'FS', -2)], 'T', '2026-12-04'), cal, TODAY)
    expect(byCode(lead).A).toMatchObject({ start: '2026-11-25', end: '2026-12-01' })
  })

  it('SS, FF and SF links', () => {
    // SS +3: T starts 3 working days after A starts.
    const ss = byCode(planBackward(makeDraft([activity('A', 10), activity('T', 5)], [link('A', 'T', 'SS', 3)], 'T', '2026-12-04'), cal, TODAY))
    expect(ss.T).toMatchObject({ start: '2026-11-30', end: '2026-12-04' })
    expect(ss.A.start).toBe('2026-11-25')
    // FF: T finishes with A.
    const ff = byCode(planBackward(makeDraft([activity('A', 10), activity('T', 2)], [link('A', 'T', 'FF')], 'T', '2026-12-04'), cal, TODAY))
    expect(ff.A).toMatchObject({ start: '2026-11-23', end: '2026-12-04' })
    expect(ff.T).toMatchObject({ start: '2026-12-03', end: '2026-12-04' })
    // SF: T finishes when A starts.
    const sf = byCode(planBackward(makeDraft([activity('A', 3), activity('T', 2)], [link('A', 'T', 'SF')], 'T', '2026-12-04'), cal, TODAY))
    expect(sf.A.start).toBe('2026-12-04')
    expect(sf.T).toMatchObject({ start: '2026-12-03', end: '2026-12-04' })
  })

  it('every root starts on the same date, the latest that meets the target', () => {
    const draft = makeDraft(
      [activity('LONG', 10), activity('SHORT', 2), activity('T', 1)],
      [link('LONG', 'T'), link('SHORT', 'T')],
      'T',
      '2026-12-04',
    )
    const plan = planBackward(draft, cal, TODAY)
    const a = byCode(plan)
    expect(a.LONG.start).toBe('2026-11-20')
    expect(a.SHORT.start).toBe('2026-11-20')
    expect(a.T.end).toBe('2026-12-04')
    expect(a.LONG.critical).toBe(true)
    expect(a.SHORT.critical).toBe(false)
    expect(a.SHORT.totalFloat).toBe(8)
    expect(plan.criticalLinks).toEqual(['LONG->T'])
  })

  it('activities after the target do not move it; mustStartBy is the earliest start', () => {
    const draft = makeDraft(
      [activity('A', 5), activity('T', 0), activity('INSTALL', 10)],
      [link('A', 'T'), link('T', 'INSTALL')],
      'T',
      '2026-12-04',
    )
    const plan = planBackward(draft, cal, TODAY)
    const a = byCode(plan)
    expect(a.T.end).toBe('2026-12-04')
    expect(a.INSTALL).toMatchObject({ start: '2026-12-07', end: '2026-12-18' })
    expect(plan.projectEnd).toBe('2026-12-18')
    expect(plan.mustStartBy).toBe('2026-11-27')
  })

  it('a lead that pulls a successor before every root sets mustStartBy', () => {
    const draft = makeDraft([activity('A', 5), activity('EARLY', 3), activity('T', 1)], [link('A', 'EARLY', 'SS', -4), link('A', 'T')], 'T', '2026-12-04')
    const plan = planBackward(draft, cal, TODAY)
    const a = byCode(plan)
    expect(a.EARLY.start < a.A.start).toBe(true)
    expect(plan.mustStartBy).toBe(a.EARLY.start)
  })

  it('the target alone (no links) starts so that it ends on the date', () => {
    const plan = planBackward(makeDraft([activity('T', 3)], [], 'T', '2026-12-04'), cal, TODAY)
    expect(byCode(plan).T).toMatchObject({ start: '2026-12-02', end: '2026-12-04', isRoot: true })
  })

  it('keeps one link per pair (the first), as the sheet will', () => {
    const links = [link('A', 'T', 'SS', 2), link('A', 'T', 'FF'), link('B', 'T')]
    expect(uniqueLinks(links)).toEqual([links[0], links[2]])
    const plan = planBackward(makeDraft([activity('A', 5), activity('B', 1), activity('T', 5)], links, 'T', '2026-12-04'), cal, TODAY)
    expect(plan.links).toHaveLength(2)
  })

  it('converts days to minutes with the calendar hours', () => {
    expect(daysToMinutes(2, cal)).toBe(960)
    expect(daysToMinutes(1, { ...cal, hoursPerDay: 10 })).toBe(600)
  })
})

describe('planBackward: the realistic LLE draft', () => {
  it('lands the milestone on the date and reproduces under a plain forward run', () => {
    const draft = lleDraft('2027-06-30')
    const plan = planBackward(draft, cal, TODAY)
    const a = byCode(plan)
    expect(a.ONSITE.end).toBe('2027-06-30')
    expect(a.SPEC.start).toBe(plan.mustStartBy)
    // Re-run the engine from the roots' start: same dates.
    const rows = draft.activities.map((x) => ({
      id: x.code,
      parentId: null,
      durationMinutes: daysToMinutes(x.durationDays, cal),
      elapsed: false,
      manualStart: x.code === 'SPEC' ? a.SPEC.start : null,
      percentComplete: 0,
    }))
    const deps = draft.links.map((l) => ({ predecessorId: l.from, successorId: l.to, type: l.type, lagMinutes: daysToMinutes(l.lagDays, cal) }))
    const forward = schedule(rows, deps, cal)
    for (const x of plan.activities) expect(forward.byRow[x.code]).toMatchObject({ start: x.start, end: x.end })
    expect(a.ONSITE.critical).toBe(true)
    expect(a.FAB.critical).toBe(true)
  })
})

/** Deterministic PRNG (mulberry32) so the random networks are the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('planBackward: convergence on random networks', () => {
  const TYPES: DepType[] = ['FS', 'SS', 'FF', 'SF']
  const holidays: Calendar = {
    workingWeekdays: [1, 2, 3, 4, 5, 6],
    nonWorkingDates: ['2026-12-25', '2027-01-01', '2027-03-15', '2027-03-16', '2027-04-02'],
    hoursPerDay: 7.5,
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])('seed %i: the target ends exactly on the date within two engine runs', (seed) => {
    const rand = rng(seed)
    const calendar = seed % 2 === 0 ? cal : holidays
    const n = 3 + Math.floor(rand() * 10)
    const activities: DraftActivity[] = []
    const links: DraftLink[] = []
    for (let i = 0; i < n; i++) {
      // About one in five is a milestone.
      activities.push(activity(`A${i}`, rand() < 0.2 ? 0 : 1 + Math.floor(rand() * 30)))
      // Links only go from earlier to later activities, so the network is acyclic.
      for (let j = 0; j < i; j++) {
        if (rand() < 0.35) {
          const lagDays = rand() < 0.5 ? 0 : Math.floor(rand() * 11) - 5 // leads and lags
          links.push(link(`A${j}`, `A${i}`, TYPES[Math.floor(rand() * 4)], lagDays))
        }
      }
    }
    const targetCode = `A${Math.floor(rand() * n)}`
    const requiredDate = `2027-0${1 + Math.floor(rand() * 9)}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`
    const plan = planBackward(makeDraft(activities, links, targetCode, requiredDate), calendar, TODAY)
    const target = plan.activities.find((a) => a.code === targetCode)!
    expect(target.end).toBe(plan.targetFinish)
    expect(isWorkingDay(calendar, plan.targetFinish)).toBe(true)
    expect(plan.targetFinish <= requiredDate).toBe(true)
    expect(plan.iterations).toBeLessThanOrEqual(2)
    // Roots share one start, and every start is a working day.
    const rootStarts = new Set(plan.activities.filter((a) => a.isRoot).map((a) => a.start))
    expect(rootStarts.size).toBe(1)
    for (const a of plan.activities) expect(isWorkingDay(calendar, a.start)).toBe(true)
  })
})

describe('planBackward: invalid drafts', () => {
  const ok = [activity('A', 5), activity('T', 5)]
  it.each([
    ['an unknown target', makeDraft(ok, [link('A', 'T')], 'NOPE', '2026-12-04'), 'target activity NOPE'],
    ['a link to an unknown code', makeDraft(ok, [link('A', 'X')], 'T', '2026-12-04'), 'unknown activity'],
    ['a self link', makeDraft(ok, [link('A', 'A')], 'T', '2026-12-04'), 'cannot depend on itself'],
    ['a cycle', makeDraft(ok, [link('A', 'T'), link('T', 'A')], 'T', '2026-12-04'), 'Dependency cycle'],
    ['a duplicate code', makeDraft([...ok, activity('A', 1)], [], 'T', '2026-12-04'), 'twice'],
    ['a negative duration', makeDraft([activity('A', -1), activity('T', 1)], [], 'T', '2026-12-04'), 'invalid duration'],
    ['a bad date', makeDraft(ok, [], 'T', '2026-02-30'), 'not a valid date'],
    ['no activities', makeDraft([], [], 'T', '2026-12-04'), 'no activities'],
  ])('rejects %s', (_name, draft, message) => {
    expect(() => planBackward(draft, cal, TODAY)).toThrow(message)
  })
})

describe('feasibility', () => {
  const draft = makeDraft([activity('A', 5), activity('T', 5)], [link('A', 'T')], 'T', '2026-12-04') // must start 2026-11-23

  it('on time: spare working days counted from the first possible start', () => {
    const f = planBackward(draft, cal, TODAY).feasibility // Sat 11-14: first possible Mon 11-16
    expect(f).toMatchObject({ feasible: true, lateByWorkingDays: 0, spareWorkingDays: 5, earliestTargetFinish: null })
    expect(f.message).toBe('Work must start by 2026-11-23: 5 working days from now.')
  })

  it('no spare time: must start today', () => {
    const f = planBackward(draft, cal, '2026-11-23').feasibility
    expect(f).toMatchObject({ feasible: true, spareWorkingDays: 0 })
    expect(f.message).toBe('Work must start today to meet the on-site date; there is no spare time.')
    // On a weekend the first possible day is the Monday.
    expect(assessFeasibility(cal, '2026-11-21', '2026-11-23', '2026-12-04').message).toContain('on 2026-11-23')
  })

  it('late: how many working days, and the earliest finish if work starts now', () => {
    const f = planBackward(draft, cal, '2026-11-25').feasibility
    expect(f).toMatchObject({ feasible: false, lateByWorkingDays: 2, spareWorkingDays: 0, earliestTargetFinish: '2026-12-08' })
    expect(f.message).toBe(
      'This plan should have started 2 working days ago; the on-site date is at risk. Starting now, the earliest finish is 2026-12-08.',
    )
    expect(assessFeasibility(cal, '2026-11-24', '2026-11-23', '2026-12-04').message).toMatch(/started 1 working day ago/)
  })

  it('a required date in the past is late too', () => {
    const past = makeDraft([activity('A', 5), activity('T', 5)], [link('A', 'T')], 'T', '2026-11-02')
    const f = planBackward(past, cal, TODAY).feasibility
    expect(f.feasible).toBe(false)
    expect(f.lateByWorkingDays).toBe(19)
  })
})
