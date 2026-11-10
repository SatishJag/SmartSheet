import { isWorkingDay, shiftIso } from '../../engine/calendar'
import type { Calendar } from '../../engine/types'

/** Pure date <-> x helpers for the Gantt timeline. Dates are ISO `YYYY-MM-DD`, UTC, calendar days. */

const DAY_MS = 24 * 60 * 60 * 1000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Width and height of a milestone diamond's bounding box, in px. */
export const MILESTONE_SIZE = 16
const MIN_RANGE_DAYS = 30
const LEAD_DAYS = 3
const TAIL_DAYS = 14

export interface DayRange {
  /** First day shown. */
  start: string
  /** Number of calendar days shown. */
  days: number
}

const toMs = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/** Calendar days from a to b (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toMs(b) - toMs(a)) / DAY_MS)
}

/** Column index of a day in a range starting at rangeStart. */
export const dayIndex = (rangeStart: string, iso: string) => daysBetween(rangeStart, iso)

/** Left x of a day's column. */
export const xOf = (rangeStart: string, iso: string, dayWidth: number) => dayIndex(rangeStart, iso) * dayWidth

/**
 * Horizontal extent of a bar. A task covers every calendar day from start to end inclusive;
 * a milestone (durationDays 0) is a fixed-size box centred on its day.
 */
export function barGeometry(
  rangeStart: string,
  s: { start: string; end: string; durationDays: number },
  dayWidth: number,
): { x: number; width: number } {
  const x = xOf(rangeStart, s.start, dayWidth)
  if (s.durationDays === 0) return { x: x + dayWidth / 2 - MILESTONE_SIZE / 2, width: MILESTONE_SIZE }
  return { x, width: (daysBetween(s.start, s.end) + 1) * dayWidth }
}

/** Working days from start to end inclusive (0 when end is before start). */
export function workingDaysInclusive(cal: Calendar, start: string, end: string): number {
  let count = 0
  for (let day = start; day <= end; day = shiftIso(day, 1)) if (isWorkingDay(cal, day)) count++
  return count
}

/**
 * The days to draw: earliest start - 3 to latest end + 14, at least 30 days.
 * With nothing scheduled: today - 3 to today + 27.
 */
export function computeRange(spans: { start: string; end: string }[], today: string): DayRange {
  if (spans.length === 0) return { start: shiftIso(today, -LEAD_DAYS), days: 31 }
  let min = spans[0].start
  let max = spans[0].end
  for (const s of spans) {
    if (s.start < min) min = s.start
    if (s.end > max) max = s.end
  }
  const start = shiftIso(min, -LEAD_DAYS)
  const days = daysBetween(start, shiftIso(max, TAIL_DAYS)) + 1
  return { start, days: Math.max(MIN_RANGE_DAYS, days) }
}

export function listDays(range: DayRange): string[] {
  return Array.from({ length: range.days }, (_, i) => shiftIso(range.start, i))
}

export interface MonthSegment {
  label: string
  startIndex: number
  days: number
}

/** Consecutive runs of days in the same month, for the header's month row. */
export function monthSegments(range: DayRange): MonthSegment[] {
  const out: MonthSegment[] = []
  listDays(range).forEach((iso, i) => {
    const label = `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`
    const last = out[out.length - 1]
    if (last && last.label === label) last.days++
    else out.push({ label, startIndex: i, days: 1 })
  })
  return out
}

/** Today's date as ISO in UTC. */
export const utcToday = () => new Date().toISOString().slice(0, 10)
