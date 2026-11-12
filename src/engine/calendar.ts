import type { Calendar } from './types'

export const defaultCalendar: Calendar = {
  workingWeekdays: [1, 2, 3, 4, 5],
  nonWorkingDates: [],
  hoursPerDay: 8,
}

const DAY_MS = 24 * 60 * 60 * 1000

function parseIso(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

function formatIso(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Shifts iso by a number of calendar days (UTC), ignoring the working calendar. */
export function shiftIso(iso: string, days: number): string {
  return formatIso(new Date(parseIso(iso).getTime() + days * DAY_MS))
}

function assertHasWorkingWeekdays(cal: Calendar): void {
  if (cal.workingWeekdays.length === 0) {
    throw new Error('Calendar has no working weekdays; cannot find a working day')
  }
}

export function isWorkingDay(cal: Calendar, iso: string): boolean {
  if (cal.nonWorkingDates.includes(iso)) return false
  return cal.workingWeekdays.includes(parseIso(iso).getUTCDay())
}

/** Returns iso itself if it is a working day, otherwise the next working day. */
export function nextWorkingDay(cal: Calendar, iso: string): string {
  assertHasWorkingWeekdays(cal)
  let current = iso
  while (!isWorkingDay(cal, current)) current = shiftIso(current, 1)
  return current
}

/**
 * Moves n working days from iso (assumed to be a working day). n may be negative.
 * n = 0 returns iso unchanged.
 */
export function addWorkingDays(cal: Calendar, iso: string, n: number): string {
  assertHasWorkingWeekdays(cal)
  const step = n < 0 ? -1 : 1
  let remaining = Math.abs(n)
  let current = iso
  while (remaining > 0) {
    current = shiftIso(current, step)
    if (isWorkingDay(cal, current)) remaining--
  }
  return current
}
