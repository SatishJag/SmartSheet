import { describe, expect, it } from 'vitest'
import { defaultCalendar } from '../../engine/calendar'
import { barGeometry, computeRange, dayIndex, MAX_RANGE_DAYS, daysBetween, listDays, monthSegments, workingDaysInclusive, xOf } from './timeScale'

describe('timeScale', () => {
  it('counts calendar days between ISO dates, across months and DST-free UTC', () => {
    expect(daysBetween('2026-11-09', '2026-11-09')).toBe(0)
    expect(daysBetween('2026-11-09', '2026-11-16')).toBe(7)
    expect(daysBetween('2026-10-30', '2026-11-02')).toBe(3)
    expect(daysBetween('2026-11-16', '2026-11-09')).toBe(-7)
    expect(dayIndex('2026-11-06', '2026-11-09')).toBe(3)
  })

  it('maps a date to x and a task to calendar-day width', () => {
    expect(xOf('2026-11-06', '2026-11-09', 28)).toBe(84)
    // Mon..Wed = 3 day columns
    expect(barGeometry('2026-11-06', { start: '2026-11-09', end: '2026-11-11', durationDays: 3 }, 28)).toEqual({ x: 84, width: 84 })
    // Fri..Tue spans the weekend: 5 calendar days wide
    expect(barGeometry('2026-11-06', { start: '2026-11-13', end: '2026-11-17', durationDays: 3 }, 28)).toEqual({
      x: 7 * 28,
      width: 5 * 28,
    })
  })

  it('gives a milestone a diamond-sized box centred on its day', () => {
    const g = barGeometry('2026-11-06', { start: '2026-11-09', end: '2026-11-09', durationDays: 0 }, 28)
    expect(g.x + g.width / 2).toBe(3 * 28 + 14)
    expect(g.width).toBe(16)
  })

  it('counts working days inclusive, skipping weekends and holidays', () => {
    expect(workingDaysInclusive(defaultCalendar, '2026-11-09', '2026-11-11')).toBe(3)
    expect(workingDaysInclusive(defaultCalendar, '2026-11-12', '2026-11-17')).toBe(4) // Thu..Tue
    expect(workingDaysInclusive(defaultCalendar, '2026-11-14', '2026-11-15')).toBe(0)
    expect(workingDaysInclusive({ ...defaultCalendar, nonWorkingDates: ['2026-11-10'] }, '2026-11-09', '2026-11-11')).toBe(2)
    expect(workingDaysInclusive(defaultCalendar, '2026-11-11', '2026-11-09')).toBe(0)
  })

  it('computes the visible range around the schedule, at least 30 days', () => {
    expect(computeRange([{ start: '2026-11-09', end: '2026-11-11' }], '2026-01-01')).toEqual({
      start: '2026-11-06',
      days: 30,
    })
    expect(computeRange([{ start: '2026-11-09', end: '2027-01-29' }], '2026-01-01')).toEqual({
      start: '2026-11-06',
      days: daysBetween('2026-11-06', '2027-01-29') + 1 + 14,
    })
    expect(computeRange([], '2026-11-10')).toEqual({ start: '2026-11-07', days: 31 })
  })

  it('caps the range at 3,650 days, keeping the earliest window, and flags it as limited', () => {
    const r = computeRange(
      [
        { start: '2026-11-09', end: '2026-11-11' },
        { start: '2099-01-01', end: '2099-01-05' },
      ],
      '2026-01-01',
    )
    expect(r).toEqual({ start: '2026-11-06', days: MAX_RANGE_DAYS, limited: true })
    expect(MAX_RANGE_DAYS).toBe(3650)
    expect(computeRange([{ start: '2026-11-09', end: '2026-11-11' }], '2026-01-01').limited).toBeUndefined()
  })

  it('lists days and month segments', () => {
    expect(listDays({ start: '2026-11-29', days: 4 })).toEqual(['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02'])
    expect(monthSegments({ start: '2026-11-29', days: 4 })).toEqual([
      { label: 'Nov 2026', startIndex: 0, days: 2 },
      { label: 'Dec 2026', startIndex: 2, days: 2 },
    ])
  })
})
