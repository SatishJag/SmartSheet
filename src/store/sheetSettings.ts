import type { Calendar } from '../engine/types'
import { fullOrder } from '../model/hierarchy'
import { isAcceptedDate, MAX_DATE, MIN_DATE, type ColumnRole } from '../model/validate'
import type { SheetData } from './persistence'

export type NormalizeCalendarResult = { ok: true; calendar: Calendar } | { ok: false; error: string }

export const HOURS_PER_DAY_MSG = 'Hours per day must be between 1 and 24 (in whole minutes)'
export const NO_WORKING_WEEKDAY_MSG = 'Choose at least one working day of the week'

/**
 * Validates a sheet calendar and returns it in canonical form: weekdays (0 = Sunday .. 6) and
 * non-working dates deduped and sorted. hoursPerDay must lie in 1..24 and be a whole number of
 * minutes (so 7.5 is fine), because durations are stored in minutes. Pure.
 */
export function normalizeCalendar(cal: Calendar): NormalizeCalendarResult {
  const weekdays = [...new Set(cal.workingWeekdays)].sort((a, b) => a - b)
  if (weekdays.length === 0) return { ok: false, error: NO_WORKING_WEEKDAY_MSG }
  if (weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return { ok: false, error: 'Working days must be weekdays 0 (Sunday) to 6 (Saturday)' }
  }
  const h = cal.hoursPerDay
  if (!Number.isFinite(h) || h < 1 || h > 24 || !Number.isInteger(Math.round(h * 60 * 1e6) / 1e6)) {
    return { ok: false, error: HOURS_PER_DAY_MSG }
  }
  for (const d of cal.nonWorkingDates) {
    if (typeof d !== 'string' || !isAcceptedDate(d)) {
      return { ok: false, error: `"${d}" is not a valid date between ${MIN_DATE} and ${MAX_DATE}` }
    }
  }
  const dates = [...new Set(cal.nonWorkingDates)].sort()
  return { ok: true, calendar: { workingWeekdays: weekdays, nonWorkingDates: dates, hoursPerDay: h } }
}

/** Same calendar, compared in canonical form. */
export function sameCalendar(a: Calendar, b: Calendar): boolean {
  return (
    a.hoursPerDay === b.hoursPerDay &&
    a.workingWeekdays.length === b.workingWeekdays.length &&
    a.workingWeekdays.every((d, i) => d === b.workingWeekdays[i]) &&
    a.nonWorkingDates.length === b.nonWorkingDates.length &&
    a.nonWorkingDates.every((d, i) => d === b.nonWorkingDates[i])
  )
}

/** The schedule columns that may not hold formulas while dependencies are on (as validateCell). */
const SCHEDULE_ROLES: readonly ColumnRole[] = ['start', 'end', 'duration', 'predecessor', 'percentComplete']

/**
 * The first formula (a string cell starting with '=') in a schedule column, in sheet order, as
 * a message for the user; null when there is none. Formulas there are only allowed while
 * dependencies are off, so turning them on is refused until they are removed.
 */
export function scheduleFormulaProblem(data: SheetData): string | null {
  const cols = data.columns.filter((c) => c.role && SCHEDULE_ROLES.includes(c.role))
  if (cols.length === 0) return null
  const byId = new Map(data.rows.map((r) => [r.id, r]))
  const order = fullOrder(data.rows)
  for (let i = 0; i < order.length; i++) {
    const row = byId.get(order[i])!
    for (const c of cols) {
      const v = row.cells[c.id]
      if (typeof v === 'string' && v.trim().startsWith('=')) {
        return `Remove the formula in ${c.title} (row ${i + 1}) first: formulas are not allowed in schedule columns when dependencies are on`
      }
    }
  }
  return null
}
