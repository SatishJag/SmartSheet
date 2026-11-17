import { describe, expect, it } from 'vitest'
import { addDays, endOfMonth, isoWeek, startOfWeek, workingDays } from './dates'
import { allocationOn, allocationSegments, availability, averageAllocation, heatLevel, periods, projectTracking } from './metrics'
import { blankPerson, blankProject, type Assignment, type Person, type Project } from './types'

const asg = (over: Partial<Assignment>): Assignment => ({
  id: 'a',
  project_id: 'p1',
  person_id: 'h',
  starts_at: '2026-11-16',
  ends_at: '2026-11-20',
  allocation_percent: 100,
  status: 'confirmed',
  notes: null,
  ...over,
})

describe('dates', () => {
  it('counts working days inclusively across weekends', () => {
    expect(workingDays('2026-11-16', '2026-11-20')).toBe(5) // Mon-Fri
    expect(workingDays('2026-11-16', '2026-11-22')).toBe(5)
    expect(workingDays('2026-11-21', '2026-11-22')).toBe(0) // Sat-Sun
    expect(workingDays('2026-11-20', '2026-11-23')).toBe(2) // Fri-Mon
    expect(workingDays('2026-11-16', '2026-12-18')).toBe(25)
    expect(workingDays('2026-11-20', '2026-11-19')).toBe(0)
  })

  it('finds week starts, month ends and ISO weeks', () => {
    expect(startOfWeek('2026-11-22')).toBe('2026-11-16') // Sunday -> Monday before
    expect(startOfWeek('2026-11-16')).toBe('2026-11-16')
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28')
    expect(isoWeek('2026-11-16')).toBe(47)
    expect(isoWeek('2026-12-28')).toBe(53)
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('periods', () => {
  it('builds weeks from the week holding the start date', () => {
    expect(periods('2026-11-18', 2, 'week')).toEqual([
      { start: '2026-11-16', end: '2026-11-22' },
      { start: '2026-11-23', end: '2026-11-29' },
    ])
  })
  it('builds months and days', () => {
    expect(periods('2026-11-18', 2, 'month')).toEqual([
      { start: '2026-11-01', end: '2026-11-30' },
      { start: '2026-12-01', end: '2026-12-31' },
    ])
    expect(periods('2026-11-18', 2, 'day').map((p) => p.start)).toEqual(['2026-11-18', '2026-11-19'])
  })
})

describe('allocation and availability', () => {
  const list = [
    asg({ id: '1', allocation_percent: 50 }),
    asg({ id: '2', starts_at: '2026-11-19', ends_at: '2026-11-25', allocation_percent: 75 }),
  ]

  it('sums allocation per day and ignores weekends', () => {
    expect(allocationOn(list, '2026-11-16')).toBe(50)
    expect(allocationOn(list, '2026-11-19')).toBe(125)
    expect(allocationOn(list, '2026-11-21')).toBe(0)
    expect(allocationOn(list, '2026-11-24')).toBe(75)
  })

  it('splits a range into constant-allocation segments', () => {
    expect(allocationSegments(list, '2026-11-16', '2026-11-29')).toEqual([
      { start: '2026-11-16', end: '2026-11-18', allocation: 50 },
      { start: '2026-11-19', end: '2026-11-20', allocation: 125 },
      { start: '2026-11-21', end: '2026-11-25', allocation: 75 },
      { start: '2026-11-26', end: '2026-11-29', allocation: 0 },
    ])
  })

  it('averages availability without letting overtime go negative', () => {
    // Week of Nov 16: 3 days at 50% free, 2 days overbooked (0% free) -> 30%
    expect(availability(list, '2026-11-16', '2026-11-22')).toBeCloseTo(30)
    expect(availability([], '2026-11-16', '2026-11-22')).toBe(100)
    expect(availability(list, '2026-11-21', '2026-11-22')).toBeNull()
    expect(averageAllocation(list, '2026-11-16', '2026-11-22')).toBeCloseTo((5 * 50 + 2 * 75) / 5)
  })

  it('maps allocation to heat levels', () => {
    expect([null, 0, 40, 100, 120].map(heatLevel)).toEqual(['none', 'free', 'partial', 'full', 'over'])
  })
})

describe('projectTracking', () => {
  const person: Person = { ...blankPerson(), id: 'h', first_name: 'Hilda', capacity_hours_per_day: 8, bill_rate: 100 }
  const people = new Map([[person.id, person]])
  const project: Project = { ...blankProject('2026-11-16'), id: 'p1', name: 'Tower', ends_at: '2026-11-27' }
  // Two weeks at 100% = 10 days, 5 before today (Nov 23).
  const list = [asg({ ends_at: '2026-11-27' })]

  it('splits incurred and future days and money at today', () => {
    const t = projectTracking({ ...project, budget_type: 'amount', budget_amount: 6000 }, list, people, '2026-11-23')
    expect(t.incurredDays).toBe(5)
    expect(t.futureDays).toBe(5)
    expect(t.incurredAmount).toBe(4000)
    expect(t.futureAmount).toBe(4000)
    expect(t.forecast).toBe(8000)
    expect(t.remaining).toBe(-2000)
    expect(t.remainingRatio).toBeCloseTo(-1 / 3)
  })

  it('tracks in days, or not at all', () => {
    const days = projectTracking({ ...project, budget_type: 'days', budget_days: 20 }, list, people, '2026-11-23')
    expect(days.forecast).toBe(10)
    expect(days.remaining).toBe(10)
    expect(days.remainingRatio).toBe(0.5)
    const none = projectTracking(project, list, people, '2026-11-23')
    expect(none.budget).toBeNull()
    expect(none.remaining).toBeNull()
  })

  it('ignores other projects', () => {
    const t = projectTracking(project, [asg({ project_id: 'other' })], people, '2026-11-23')
    expect(t.incurredDays + t.futureDays).toBe(0)
  })
})

import { dateAt, xOf } from './timeline'

describe('timeline geometry', () => {
  const weeks = periods('2026-11-16', 3, 'week')
  it('places dates proportionally inside week columns and clamps outside', () => {
    expect(xOf(weeks, 70, '2026-11-16')).toBe(0)
    expect(xOf(weeks, 70, '2026-11-23')).toBe(70)
    expect(xOf(weeks, 70, '2026-11-24')).toBe(80)
    expect(xOf(weeks, 70, '2026-11-22', true)).toBe(70)
    expect(xOf(weeks, 70, '2026-01-01')).toBe(0)
    expect(xOf(weeks, 70, '2027-01-01')).toBe(210)
  })
  it('maps a position back to its date', () => {
    expect(dateAt(weeks, 70, 0)).toBe('2026-11-16')
    expect(dateAt(weeks, 70, 85)).toBe('2026-11-24')
    expect(dateAt(weeks, 70, 9999)).toBe('2026-12-06')
  })
})
