import { describe, expect, it } from 'vitest'
import type { Calendar } from '../engine/types'
import { CAL, assign, person, task } from './testkit'
import {
  assignmentDays,
  bucketStartDay,
  bucketsFor,
  buildLoad,
  capacityFn,
  contributions,
  dayLoad,
  dayNumber,
  findAvailable,
  isoOfDay,
  loadLevel,
  overAllocatedDays,
  previewAssignment,
  spreadHours,
  utilizationOf,
  utilizationSummary,
  weekdayOfDay,
  workingDayNumbers,
} from './engine'

// 2026-11-16 is a Monday.
const MON = '2026-11-16'
const FRI = '2026-11-20'

describe('dates', () => {
  it('converts between ISO dates and day numbers and knows the weekday', () => {
    expect(isoOfDay(dayNumber('2026-11-16'))).toBe('2026-11-16')
    expect(weekdayOfDay(dayNumber('1970-01-01'))).toBe(4)
    expect(weekdayOfDay(dayNumber(MON))).toBe(1)
    expect(weekdayOfDay(dayNumber('2026-11-15'))).toBe(0)
    expect(weekdayOfDay(dayNumber('1969-12-31'))).toBe(3)
  })

  it('finds the Monday and month starts', () => {
    expect(isoOfDay(bucketStartDay('week', dayNumber('2026-11-22')))).toBe('2026-11-16') // Sunday -> prior Monday
    expect(isoOfDay(bucketStartDay('week', dayNumber(MON)))).toBe(MON)
    expect(isoOfDay(bucketStartDay('month', dayNumber('2026-11-30')))).toBe('2026-11-01')
    expect(isoOfDay(bucketStartDay('day', dayNumber(MON)))).toBe(MON)
  })

  it('lists only the working days of a calendar in a range', () => {
    const cal: Calendar = { ...CAL, nonWorkingDates: ['2026-11-18'] }
    expect(workingDayNumbers(MON, '2026-11-23', cal).map(isoOfDay)).toEqual(['2026-11-16', '2026-11-17', '2026-11-19', '2026-11-20', '2026-11-23'])
    expect(workingDayNumbers('2026-11-20', MON, CAL)).toEqual([])
  })
})

describe('capacity', () => {
  it('uses the weekly pattern', () => {
    const cap = capacityFn(person('a', { hoursByWeekday: [0, 8, 8, 8, 8, 4, 0] }))
    expect(cap(dayNumber(MON))).toBe(8)
    expect(cap(dayNumber(FRI))).toBe(4)
    expect(cap(dayNumber('2026-11-21'))).toBe(0)
  })

  it('time off overrides the weekly hours, 0 = away, partial days allowed', () => {
    const cap = capacityFn(
      person('a', {
        timeOff: [
          { start: '2026-11-17', end: '2026-11-18', hours: 0 },
          { start: '2026-11-19', end: '2026-11-19', hours: 4 },
        ],
      }),
    )
    expect([MON, '2026-11-17', '2026-11-18', '2026-11-19', FRI].map((d) => cap(dayNumber(d)))).toEqual([8, 0, 0, 4, 8])
  })

  it('where time off overlaps the smaller figure wins', () => {
    const cap = capacityFn(person('a', { timeOff: [{ start: MON, end: FRI, hours: 4 }, { start: '2026-11-18', end: '2026-11-18', hours: 0 }] }))
    expect([MON, '2026-11-18'].map((d) => cap(dayNumber(d)))).toEqual([4, 0])
  })

  it('can add hours on a day the weekly pattern has none (a Saturday shift)', () => {
    const cap = capacityFn(person('a', { timeOff: [{ start: '2026-11-21', end: '2026-11-21', hours: 6 }] }))
    expect(cap(dayNumber('2026-11-21'))).toBe(6)
  })
})

describe('spreadHours', () => {
  const days = workingDayNumbers(MON, FRI, CAL) // 5 days
  const cap = capacityFn(person('a'))

  it('percent of the capacity each day', () => {
    expect(spreadHours({ kind: 'percent', value: 50 }, days, cap)).toEqual([4, 4, 4, 4, 4])
    expect(spreadHours({ kind: 'percent', value: 150 }, days, cap)).toEqual([12, 12, 12, 12, 12])
  })

  it('percent of a part day is a part of it, and nothing on time off', () => {
    const c = capacityFn(person('a', { hoursByWeekday: [0, 8, 4, 8, 0, 8, 0], timeOff: [] }))
    expect(spreadHours({ kind: 'percent', value: 50 }, days, c)).toEqual([4, 2, 4, 0, 4])
  })

  it('hours per day only on days with capacity', () => {
    const c = capacityFn(person('a', { timeOff: [{ start: '2026-11-18', end: '2026-11-18', hours: 0 }] }))
    expect(spreadHours({ kind: 'hours_per_day', value: 6 }, days, c)).toEqual([6, 6, 0, 6, 6])
  })

  it('hours per week is divided over the resource working days per week', () => {
    expect(spreadHours({ kind: 'hours_per_week', value: 20 }, days, cap, 5)).toEqual([4, 4, 4, 4, 4])
    expect(spreadHours({ kind: 'hours_per_week', value: 20 }, days, cap, 4)).toEqual([5, 5, 5, 5, 5])
  })

  it('total hours are spread evenly over equal days', () => {
    const out = spreadHours({ kind: 'total_hours', value: 40 }, days, cap)
    expect(out).toEqual([8, 8, 8, 8, 8])
  })

  it('total hours follow the capacity of each day (part days get less) and skip time off', () => {
    const c = capacityFn(person('a', { hoursByWeekday: [0, 8, 4, 8, 8, 8, 0], timeOff: [{ start: '2026-11-19', end: '2026-11-19', hours: 0 }] }))
    const out = spreadHours({ kind: 'total_hours', value: 28 }, days, c)
    // capacities 8,4,8,0,8 -> sum 28
    expect(out).toEqual([8, 4, 8, 0, 8])
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(28)
  })

  it('total hours always add up to the total', () => {
    const c = capacityFn(person('a', { hoursByWeekday: [0, 7, 3, 5, 8, 1, 0] }))
    const out = spreadHours({ kind: 'total_hours', value: 37.5 }, days, c)
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(37.5, 9)
  })

  it('falls back to every task day when the resource has no capacity on any of them (so it shows as over-allocated)', () => {
    const c = capacityFn(person('a', { timeOff: [{ start: MON, end: FRI, hours: 0 }] }))
    expect(spreadHours({ kind: 'hours_per_day', value: 2 }, days, c)).toEqual([2, 2, 2, 2, 2])
    expect(spreadHours({ kind: 'total_hours', value: 10 }, days, c)).toEqual([2, 2, 2, 2, 2])
    expect(spreadHours({ kind: 'percent', value: 100 }, days, c)).toEqual([0, 0, 0, 0, 0])
  })

  it('zero or no days give zero hours', () => {
    expect(spreadHours({ kind: 'percent', value: 100 }, [], cap)).toEqual([])
    expect(spreadHours({ kind: 'percent', value: 0 }, days, cap)).toEqual([0, 0, 0, 0, 0])
  })
})

describe('assignmentDays', () => {
  it('follows the task; a milestone has no days', () => {
    expect(assignmentDays({ startDate: null, endDate: null }, task('t', MON, FRI))).toHaveLength(5)
    expect(assignmentDays({ startDate: null, endDate: null }, task('m', MON, MON, { durationDays: 0 }))).toEqual([])
  })

  it('its own dates replace the task dates (also on a milestone)', () => {
    expect(assignmentDays({ startDate: '2026-11-18', endDate: FRI }, task('t', MON, FRI)).map(isoOfDay)).toEqual(['2026-11-18', '2026-11-19', FRI])
    expect(assignmentDays({ startDate: MON, endDate: '2026-11-17' }, task('m', MON, MON, { durationDays: 0 }))).toHaveLength(2)
    expect(assignmentDays({ startDate: '2026-11-18', endDate: null }, task('t', MON, FRI))).toHaveLength(3)
  })

  it('uses the sheet calendar (holidays skipped)', () => {
    const t = task('t', MON, FRI, { calendar: { ...CAL, nonWorkingDates: ['2026-11-18'] } })
    expect(assignmentDays({ startDate: null, endDate: null }, t)).toHaveLength(4)
  })
})

describe('buildLoad and day load', () => {
  it('sums assignments on the same resource and day', () => {
    const m = buildLoad(
      [person('a')],
      [assign('1', 'a', 't1', { kind: 'percent', value: 50 }), assign('2', 'a', 't2', { kind: 'hours_per_day', value: 2 })],
      [task('t1', MON, FRI), task('t2', MON, '2026-11-17')],
    )
    expect(dayLoad(m, 'a', dayNumber(MON))).toEqual({ assigned: 6, available: 8 })
    expect(dayLoad(m, 'a', dayNumber('2026-11-18'))).toEqual({ assigned: 4, available: 8 })
    expect(dayLoad(m, 'a', dayNumber('2026-11-21'))).toEqual({ assigned: 0, available: 0 })
  })

  it('ignores assignments whose task or resource is unknown and reports them', () => {
    const a1 = assign('1', 'a', 'gone', { kind: 'percent', value: 100 })
    const a2 = assign('2', 'nobody', 't1', { kind: 'percent', value: 100 })
    const m = buildLoad([person('a')], [a1, a2], [task('t1', MON, FRI)])
    expect(m.skipped).toEqual([a1, a2])
    expect(dayLoad(m, 'a', dayNumber(MON)).assigned).toBe(0)
  })

  it('moves with the task: a later task window moves the hours', () => {
    const a = assign('1', 'a', 't1', { kind: 'percent', value: 100 })
    const before = buildLoad([person('a')], [a], [task('t1', MON, '2026-11-17')])
    const after = buildLoad([person('a')], [a], [task('t1', '2026-11-23', '2026-11-24')])
    expect(dayLoad(before, 'a', dayNumber(MON)).assigned).toBe(8)
    expect(dayLoad(after, 'a', dayNumber(MON)).assigned).toBe(0)
    expect(dayLoad(after, 'a', dayNumber('2026-11-23')).assigned).toBe(8)
  })

  it('an assignment with its own dates stays when the task moves', () => {
    const a = assign('1', 'a', 't1', { kind: 'percent', value: 100 }, { startDate: MON, endDate: MON })
    const m = buildLoad([person('a')], [a], [task('t1', '2026-11-23', '2026-11-24')])
    expect(dayLoad(m, 'a', dayNumber(MON)).assigned).toBe(8)
    expect(dayLoad(m, 'a', dayNumber('2026-11-23')).assigned).toBe(0)
  })
})

describe('buckets, heat levels and over-allocation', () => {
  const resources = [person('a')]
  const tasks = [task('t1', MON, FRI), task('t2', '2026-11-18', '2026-11-18')]

  it('classifies load', () => {
    expect(loadLevel(0, 8)).toBe('none')
    expect(loadLevel(3, 8)).toBe('low')
    expect(loadLevel(5, 8)).toBe('mid')
    expect(loadLevel(7, 8)).toBe('high')
    expect(loadLevel(8, 8)).toBe('high')
    expect(loadLevel(8.5, 8)).toBe('over')
    expect(loadLevel(1, 0)).toBe('over')
  })

  it('builds week buckets with assigned vs available and utilisation', () => {
    const m = buildLoad(resources, [assign('1', 'a', 't1', { kind: 'percent', value: 50 })], tasks)
    const [w] = bucketsFor(m, 'a', 'week', MON, FRI)
    expect(w).toMatchObject({ start: MON, end: '2026-11-22', assigned: 20, available: 40, utilization: 0.5, overDays: 0, over: false, level: 'mid' })
  })

  it('flags a week over when one day is over even though the weekly total is not', () => {
    const m = buildLoad(
      resources,
      [assign('1', 'a', 't1', { kind: 'percent', value: 50 }), assign('2', 'a', 't2', { kind: 'hours_per_day', value: 6 })],
      tasks,
    )
    // Wednesday: 4 + 6 = 10 > 8
    const [w] = bucketsFor(m, 'a', 'week', MON, FRI)
    expect(w.assigned).toBe(26)
    expect(w.assigned).toBeLessThan(w.available)
    expect(w.overDays).toBe(1)
    expect(w.over).toBe(true)
    expect(w.level).toBe('over')
    expect(overAllocatedDays(m, 'a', MON, FRI).map(isoOfDay)).toEqual(['2026-11-18'])
  })

  it('day buckets, month buckets and a resource with nothing assigned', () => {
    const m = buildLoad(resources, [assign('1', 'a', 't1', { kind: 'hours_per_day', value: 8 })], tasks)
    const days = bucketsFor(m, 'a', 'day', MON, '2026-11-22')
    expect(days).toHaveLength(7)
    expect(days.map((b) => b.assigned)).toEqual([8, 8, 8, 8, 8, 0, 0])
    expect(days[5]).toMatchObject({ available: 0, utilization: null, level: 'none' })
    const months = bucketsFor(m, 'a', 'month', MON, '2026-12-10')
    expect(months.map((b) => b.start)).toEqual(['2026-11-01', '2026-12-01'])
    expect(months[0].end).toBe('2026-11-30')
    expect(months[0].assigned).toBe(40)
    expect(bucketsFor(m, 'nobody', 'week', MON, FRI)[0]).toMatchObject({ assigned: 0, available: 0 })
  })

  it('work on a day the resource is away is over-allocation against zero capacity', () => {
    const away = person('a', { timeOff: [{ start: '2026-11-18', end: '2026-11-18', hours: 0 }] })
    const m = buildLoad([away], [assign('1', 'a', 't2', { kind: 'hours_per_day', value: 4 })], tasks)
    expect(overAllocatedDays(m, 'a', MON, FRI).map(isoOfDay)).toEqual(['2026-11-18'])
  })

  it('utilisation totals and the peak day', () => {
    const m = buildLoad(
      resources,
      [assign('1', 'a', 't1', { kind: 'percent', value: 50 }), assign('2', 'a', 't2', { kind: 'hours_per_day', value: 6 })],
      tasks,
    )
    const u = utilizationOf(m, 'a', MON, FRI)
    expect(u.assigned).toBe(26)
    expect(u.available).toBe(40)
    expect(u.utilization).toBeCloseTo(0.65)
    expect(u.overDays).toBe(1)
    expect(u.excessHours).toBe(2)
    expect(u.peak).toEqual({ day: '2026-11-18', assigned: 10, available: 8 })
    expect(utilizationOf(m, 'nobody', MON, FRI).assigned).toBe(0)
    expect(utilizationSummary(m, MON, FRI).map((x) => x.resourceId)).toEqual(['a'])
  })

  it('lists the assignments behind a number, biggest first', () => {
    const m = buildLoad(
      resources,
      [assign('1', 'a', 't1', { kind: 'percent', value: 50 }), assign('2', 'a', 't2', { kind: 'hours_per_day', value: 6 })],
      tasks,
    )
    const c = contributions(m, 'a', '2026-11-18', '2026-11-18')
    expect(c.map((x) => [x.assignmentId, x.hours])).toEqual([['2', 6], ['1', 4]])
    expect(contributions(m, 'a', MON, FRI).find((x) => x.assignmentId === '1')).toMatchObject({ hours: 20, days: 5 })
    expect(contributions(m, 'a', '2026-12-01', '2026-12-02')).toEqual([])
  })
})

describe('findAvailable', () => {
  const resources = [
    person('free', { department: 'Electrical', skills: ['Wiring', 'Testing'] }),
    person('busy', { department: 'Electrical', skills: ['Wiring'] }),
    person('away', { department: 'Civil', timeOff: [{ start: MON, end: FRI, hours: 0 }] }),
    person('crane', { kind: 'equipment', department: 'Civil' }),
  ]
  const m = buildLoad(resources, [assign('1', 'busy', 't1', { kind: 'percent', value: 100 })], [task('t1', MON, FRI)])

  it('ranks those that fit first, then by free hours', () => {
    const r = findAvailable(m, { from: MON, to: FRI, hoursPerDay: 4 })
    expect(r.map((x) => [x.resourceId, x.fits])).toEqual([['crane', true], ['free', true], ['away', false], ['busy', false]])
    expect(r.find((x) => x.resourceId === 'free')).toMatchObject({ freeHours: 40, workingDays: 5, minFreePerDay: 8 })
    expect(r.find((x) => x.resourceId === 'busy')).toMatchObject({ freeHours: 0, assignedHours: 40 })
    expect(r.find((x) => x.resourceId === 'away')).toMatchObject({ workingDays: 0, freeHours: 0 })
  })

  it('percent and total-hours needs', () => {
    expect(findAvailable(m, { from: MON, to: FRI, percent: 50 }).filter((x) => x.fits).map((x) => x.resourceId)).toEqual(['crane', 'free'])
    expect(findAvailable(m, { from: MON, to: FRI, totalHours: 41 }).every((x) => !x.fits)).toBe(true)
    expect(findAvailable(m, { from: MON, to: FRI, totalHours: 40 }).filter((x) => x.fits).map((x) => x.resourceId)).toEqual(['crane', 'free'])
  })

  it('without a need, any free time counts', () => {
    expect(findAvailable(m, { from: MON, to: FRI }).filter((x) => x.fits).map((x) => x.resourceId)).toEqual(['crane', 'free'])
  })

  it('filters by department, kind, skills (case-insensitive) and exclusions', () => {
    expect(findAvailable(m, { from: MON, to: FRI, department: 'electrical' }).map((x) => x.resourceId)).toEqual(['free', 'busy'])
    expect(findAvailable(m, { from: MON, to: FRI, kind: 'equipment' }).map((x) => x.resourceId)).toEqual(['crane'])
    expect(findAvailable(m, { from: MON, to: FRI, skills: ['testing', 'WIRING'] }).map((x) => x.resourceId)).toEqual(['free'])
    expect(findAvailable(m, { from: MON, to: FRI, excludeIds: ['free'], department: 'Electrical' }).map((x) => x.resourceId)).toEqual(['busy'])
  })

  it('a partly loaded week fits a small need but not a big one', () => {
    const m2 = buildLoad([person('a')], [assign('1', 'a', 't1', { kind: 'hours_per_day', value: 6 })], [task('t1', MON, FRI)])
    expect(findAvailable(m2, { from: MON, to: FRI, hoursPerDay: 2 })[0].fits).toBe(true)
    expect(findAvailable(m2, { from: MON, to: FRI, hoursPerDay: 3 })[0].fits).toBe(false)
  })
})

describe('previewAssignment', () => {
  it('reports hours and the days that would be over, without counting the assignment being edited twice', () => {
    const t1 = task('t1', MON, FRI)
    const t2 = task('t2', MON, '2026-11-17')
    const m = buildLoad([person('a')], [assign('1', 'a', 't1', { kind: 'percent', value: 75 })], [t1, t2])
    const p = previewAssignment(m, 'a', t2, { kind: 'percent', value: 50 })
    expect(p.totalHours).toBe(8)
    expect(p.overDays.map(isoOfDay)).toEqual([MON, '2026-11-17']) // 6 + 4 > 8
    const q = previewAssignment(m, 'a', t1, { kind: 'percent', value: 100 }, { startDate: null, endDate: null }, '1')
    expect(q.overDays).toEqual([]) // replacing, not adding
    expect(previewAssignment(m, 'nobody', t2, { kind: 'percent', value: 50 }).days).toEqual([])
  })
})
