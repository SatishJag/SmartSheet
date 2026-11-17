/**
 * Resource-management arithmetic: allocation, availability and project budget tracking.
 *
 * An assignment books `allocation_percent` of a person's daily capacity on every working day
 * (Mon-Fri) from its start to its end, inclusive. Days are person-days at 100%; hours are days
 * times the person's capacity; money is hours times the person's bill rate. Everything before
 * `today` counts as incurred, today and later as future scheduled.
 */
import { addDays, addMonths, endOfMonth, endOfWeek, isWorkingDay, overlap, startOfMonth, startOfWeek, workingDays } from './dates'
import type { Assignment, Person, Project } from './types'

export type Zoom = 'day' | 'week' | 'month'

export interface Period {
  start: string
  end: string
}

/** `count` consecutive periods of the zoom level, starting with the one that holds `from`. */
export function periods(from: string, count: number, zoom: Zoom): Period[] {
  const out: Period[] = []
  let start = zoom === 'day' ? from : zoom === 'week' ? startOfWeek(from) : startOfMonth(from)
  for (let i = 0; i < count; i++) {
    const end = zoom === 'day' ? start : zoom === 'week' ? endOfWeek(start) : endOfMonth(start)
    out.push({ start, end })
    start = zoom === 'month' ? addMonths(start, 1) : addDays(end, 1)
  }
  return out
}

/** Total allocation (percent) booked for a person on one day; 0 on weekends. */
export function allocationOn(assignments: readonly Assignment[], day: string): number {
  if (!isWorkingDay(day)) return 0
  let sum = 0
  for (const a of assignments) if (a.starts_at <= day && day <= a.ends_at) sum += a.allocation_percent
  return sum
}

/** Average allocation (percent) over the working days of [start, end]; null if there are none. */
export function averageAllocation(assignments: readonly Assignment[], start: string, end: string): number | null {
  const days = workingDays(start, end)
  if (days === 0) return null
  let booked = 0
  for (const a of assignments) {
    const o = overlap(a.starts_at, a.ends_at, start, end)
    if (o) booked += workingDays(o[0], o[1]) * a.allocation_percent
  }
  return booked / days
}

/**
 * Availability over [start, end]: the average of (100% - allocation) across working days, never
 * below 0 on any one day (overtime on Tuesday does not free up Wednesday). Null with no working day.
 */
export function availability(assignments: readonly Assignment[], start: string, end: string): number | null {
  if (workingDays(start, end) === 0) return null
  let free = 0
  let days = 0
  for (const seg of allocationSegments(assignments, start, end)) {
    const n = workingDays(seg.start, seg.end)
    days += n
    free += n * Math.max(0, 100 - seg.allocation)
  }
  return days === 0 ? null : free / days
}

export interface AllocationSegment {
  start: string
  end: string
  /** Total allocation percent on each working day of the segment. */
  allocation: number
}

/**
 * Splits [start, end] into maximal runs of constant total allocation (weekends inherit the run
 * they sit in, so a constant booking is one segment). Used to draw availability strips.
 */
export function allocationSegments(assignments: readonly Assignment[], start: string, end: string): AllocationSegment[] {
  if (end < start) return []
  // Change points: every assignment start, and the day after every end, inside the range.
  const cuts = new Set<string>([start])
  for (const a of assignments) {
    if (a.starts_at > start && a.starts_at <= end) cuts.add(a.starts_at)
    const after = addDays(a.ends_at, 1)
    if (after > start && after <= end) cuts.add(after)
  }
  const sorted = [...cuts].sort()
  const out: AllocationSegment[] = []
  sorted.forEach((s, i) => {
    const e = i + 1 < sorted.length ? addDays(sorted[i + 1], -1) : end
    let allocation = 0
    for (const a of assignments) if (a.starts_at <= s && s <= a.ends_at) allocation += a.allocation_percent
    const prev = out[out.length - 1]
    if (prev && prev.allocation === allocation) prev.end = e
    else out.push({ start: s, end: e, allocation })
  })
  return out
}

/** Person-days booked by one assignment within [start, end] (whole range if omitted). */
export function assignmentDays(a: Assignment, start = a.starts_at, end = a.ends_at): number {
  const o = overlap(a.starts_at, a.ends_at, start, end)
  return o ? (workingDays(o[0], o[1]) * a.allocation_percent) / 100 : 0
}

export interface ProjectTracking {
  incurredDays: number
  futureDays: number
  incurredAmount: number
  futureAmount: number
  /** Budget in the project's tracking unit (money or days); null when not tracked. */
  budget: number | null
  /** Incurred + future in the tracking unit. */
  forecast: number
  /** budget - forecast (negative: over budget); null when not tracked. */
  remaining: number | null
  /** remaining / budget; null when not tracked or the budget is 0. */
  remainingRatio: number | null
}

export function projectTracking(
  project: Project,
  assignments: readonly Assignment[],
  peopleById: ReadonlyMap<string, Person>,
  today: string,
): ProjectTracking {
  const yesterday = addDays(today, -1)
  let incurredDays = 0
  let futureDays = 0
  let incurredAmount = 0
  let futureAmount = 0
  for (const a of assignments) {
    if (a.project_id !== project.id) continue
    const person = peopleById.get(a.person_id)
    const rate = person ? person.capacity_hours_per_day * person.bill_rate : 0
    const past = assignmentDays(a, a.starts_at, yesterday)
    const future = assignmentDays(a, today, a.ends_at)
    incurredDays += past
    futureDays += future
    incurredAmount += past * rate
    futureAmount += future * rate
  }
  const budget =
    project.budget_type === 'amount' ? project.budget_amount ?? 0 : project.budget_type === 'days' ? project.budget_days ?? 0 : null
  const forecast = project.budget_type === 'days' ? incurredDays + futureDays : incurredAmount + futureAmount
  const remaining = budget === null ? null : budget - forecast
  const remainingRatio = budget === null || budget === 0 ? null : (remaining as number) / budget
  return { incurredDays, futureDays, incurredAmount, futureAmount, budget, forecast, remaining, remainingRatio }
}

/** Groups assignments by person id. */
export function byPerson(assignments: readonly Assignment[]): Map<string, Assignment[]> {
  const map = new Map<string, Assignment[]>()
  for (const a of assignments) {
    const list = map.get(a.person_id)
    if (list) list.push(a)
    else map.set(a.person_id, [a])
  }
  return map
}

/** Heat level for an allocation percent: drives the heatmap colours. */
export function heatLevel(allocation: number | null): 'none' | 'free' | 'partial' | 'full' | 'over' {
  if (allocation === null) return 'none'
  if (allocation <= 0) return 'free'
  if (allocation < 100) return 'partial'
  if (allocation <= 100.0001) return 'full'
  return 'over'
}

export const formatPercent = (n: number | null) => (n === null ? '--' : `${Math.round(n)}%`)

export function formatMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

export const formatDays = (n: number) => `${Math.round(n * 10) / 10}`
