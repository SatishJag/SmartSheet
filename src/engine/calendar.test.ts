import { describe, it, expect } from 'vitest'
import { addWorkingDays, defaultCalendar, isWorkingDay, nextWorkingDay, previousWorkingDay } from './calendar'

describe('calendar', () => {
  it('detects weekends as non-working', () => {
    expect(isWorkingDay(defaultCalendar, '2026-11-09')).toBe(true) // Monday
    expect(isWorkingDay(defaultCalendar, '2026-11-14')).toBe(false) // Saturday
  })

  it('nextWorkingDay skips a weekend and keeps working days', () => {
    expect(nextWorkingDay(defaultCalendar, '2026-11-14')).toBe('2026-11-16')
    expect(nextWorkingDay(defaultCalendar, '2026-11-16')).toBe('2026-11-16')
  })

  it('adds working days forward across a weekend', () => {
    expect(addWorkingDays(defaultCalendar, '2026-11-13', 3)).toBe('2026-11-18')
  })

  it('adds working days backward', () => {
    expect(addWorkingDays(defaultCalendar, '2026-11-16', -1)).toBe('2026-11-13')
  })

  it('returns the same date for n = 0', () => {
    expect(addWorkingDays(defaultCalendar, '2026-11-09', 0)).toBe('2026-11-09')
  })

  it('skips non-working dates', () => {
    const cal = { ...defaultCalendar, nonWorkingDates: ['2026-11-10'] }
    expect(isWorkingDay(cal, '2026-11-10')).toBe(false)
    expect(addWorkingDays(cal, '2026-11-09', 1)).toBe('2026-11-11')
  })

  it('throws on a calendar with no working weekdays', () => {
    const cal = { ...defaultCalendar, workingWeekdays: [] }
    expect(() => nextWorkingDay(cal, '2026-11-09')).toThrow(/no working/i)
    expect(() => addWorkingDays(cal, '2026-11-09', 1)).toThrow(/no working/i)
  })
})

describe('previousWorkingDay', () => {
  it('returns a working day unchanged and otherwise the closest one before', () => {
    expect(previousWorkingDay(defaultCalendar, '2026-11-13')).toBe('2026-11-13') // Friday
    expect(previousWorkingDay(defaultCalendar, '2026-11-15')).toBe('2026-11-13') // Sunday
    const cal = { ...defaultCalendar, nonWorkingDates: ['2026-11-13'] }
    expect(previousWorkingDay(cal, '2026-11-15')).toBe('2026-11-12')
  })
})
