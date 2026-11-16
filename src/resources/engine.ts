/**
 * Resource management engine: pure functions, no I/O. Turns assignments (a resource on a task with
 * an allocation) into hours per resource per day, and answers the workload questions on top of it.
 *
 * Allocation semantics (see docs/superpowers/specs/2026-11-16-resources-design.md):
 *
 * - A task occupies the *working days of its sheet's calendar* between its start and end. A
 *   milestone (0 days) occupies none. An assignment may carry its own start/end, which replace the
 *   task's dates (such an assignment no longer follows the task).
 * - A resource has a weekly capacity (hours per weekday) and time-off ranges (hours per day on those
 *   dates, 0 = away; where ranges overlap the smallest figure wins). Its capacity on a day is that.
 * - `percent`        demand on a day = value% of the resource's capacity that day (part days work out
 *                    naturally; 100% of a 4h day is 4h; nothing on time off).
 * - `hours_per_day`  demand = value hours on every task day on which the resource has capacity.
 * - `hours_per_week` the weekly figure is divided by the resource's working days per week and placed
 *                    like hours_per_day.
 * - `total_hours`    spread over the task days with capacity, in proportion to that day's capacity.
 * - If the resource has no capacity on any task day (e.g. the whole task falls in time off), the
 *   fixed-hours kinds fall back to *all* task days, so the demand shows up as an over-allocation
 *   instead of vanishing. `percent` of zero capacity is zero.
 * - Over-allocated = assigned hours > available hours (day level; a week/month bucket is flagged when
 *   its sum is over or any day inside it is).
 */

import type { Calendar } from '../engine/types'

export type ResourceKind = 'person' | 'role' | 'equipment'

export interface TimeOff {
  /** First and last date (inclusive), YYYY-MM-DD. */
  start: string
  end: string
  /** Capacity on those dates in hours per day; 0 = away. */
  hours: number
  note?: string
}

export interface Resource {
  id: string
  name: string
  kind: ResourceKind
  department: string | null
  skills: string[]
  costRate: number
  /** Capacity in hours for each weekday, 0 = Sunday ... 6 = Saturday. */
  hoursByWeekday: number[]
  timeOff: TimeOff[]
}

export type AllocationKind = 'percent' | 'hours_per_day' | 'hours_per_week' | 'total_hours'

export interface Allocation {
  kind: AllocationKind
  value: number
}

export interface Assignment {
  id: string
  sheetId: string
  rowId: string
  resourceId: string
  allocation: Allocation
  /** Replaces the task's start / end when set; null follows the task. */
  startDate: string | null
  endDate: string | null
}

/** What the engine needs to know about one scheduled task. */
export interface TaskFact {
  sheetId: string
  rowId: string
  name: string
  start: string
  end: string
  durationDays: number
  elapsed: boolean
  calendar: Calendar
  /** Float in working days; null when unknown (dependencies off or sheet not analysable). */
  totalFloat: number | null
  freeFloat: number | null
  critical: boolean
}

export const taskKey = (sheetId: string, rowId: string) => `${sheetId}:${rowId}`

export const DEFAULT_HOURS_BY_WEEKDAY: readonly number[] = [0, 8, 8, 8, 8, 8, 0]
export const EPS = 1e-6

// ---- dates -------------------------------------------------------------------------------------

const DAY_MS = 86_400_000

export function dayNumber(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS)
}

export function isoOfDay(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10)
}

/** 0 = Sunday ... 6 = Saturday (1970-01-01 was a Thursday). */
export function weekdayOfDay(n: number): number {
  return (((n + 4) % 7) + 7) % 7
}

export type BucketUnit = 'day' | 'week' | 'month'

/** First day (as a day number) of the bucket of `unit` that contains day `n`. Weeks start on Monday. */
export function bucketStartDay(unit: BucketUnit, n: number): number {
  if (unit === 'day') return n
  if (unit === 'week') return n - ((weekdayOfDay(n) + 6) % 7)
  const d = new Date(n * DAY_MS)
  return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY_MS)
}

/** First day of the bucket after the one starting at `start`. */
export function nextBucketStartDay(unit: BucketUnit, start: number): number {
  if (unit === 'day') return start + 1
  if (unit === 'week') return start + 7
  const d = new Date(start * DAY_MS)
  return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / DAY_MS)
}

// ---- capacity ----------------------------------------------------------------------------------

export type CapacityFn = (day: number) => number

/** The resource's capacity in hours on a day (a day number). O(1) after construction. */
export function capacityFn(resource: Pick<Resource, 'hoursByWeekday' | 'timeOff'>): CapacityFn {
  const weekly = resource.hoursByWeekday.length === 7 ? resource.hoursByWeekday : [...DEFAULT_HOURS_BY_WEEKDAY]
  const exceptions = new Map<number, number>()
  for (const t of resource.timeOff) {
    const a = dayNumber(t.start)
    const b = dayNumber(t.end)
    if (!(b >= a) || b - a > 3660) continue
    for (let d = a; d <= b; d++) {
      const prev = exceptions.get(d)
      exceptions.set(d, prev === undefined ? t.hours : Math.min(prev, t.hours))
    }
  }
  return (day) => {
    const e = exceptions.size === 0 ? undefined : exceptions.get(day)
    return e !== undefined ? e : weekly[weekdayOfDay(day)]
  }
}

function workdaysPerWeek(resource: Pick<Resource, 'hoursByWeekday'>): number {
  const n = resource.hoursByWeekday.filter((h) => h > 0).length
  return n === 0 ? 5 : n
}

// ---- spreading an assignment over days -------------------------------------------------------

const nonWorkingCache = new WeakMap<Calendar, Set<number>>()
function nonWorkingSet(cal: Calendar): Set<number> {
  let s = nonWorkingCache.get(cal)
  if (!s) {
    s = new Set(cal.nonWorkingDates.map(dayNumber))
    nonWorkingCache.set(cal, s)
  }
  return s
}

/** Working days (day numbers) of `cal` in [start, end]. Empty when end < start or nothing in between works. */
export function workingDayNumbers(start: string, end: string, cal: Calendar): number[] {
  const a = dayNumber(start)
  const b = dayNumber(end)
  const out: number[] = []
  if (!(b >= a)) return out
  const off = nonWorkingSet(cal)
  const weekdays = cal.workingWeekdays
  for (let d = a; d <= b; d++) {
    if (weekdays.includes(weekdayOfDay(d)) && !off.has(d)) out.push(d)
  }
  return out
}

/** The days an assignment is planned on: the assignment's own dates, else the task's. */
export function assignmentDays(a: Pick<Assignment, 'startDate' | 'endDate'>, task: TaskFact): number[] {
  const overridden = a.startDate !== null || a.endDate !== null
  if (task.durationDays <= 0 && !overridden) return []
  return workingDayNumbers(a.startDate ?? task.start, a.endDate ?? task.end, task.calendar)
}

/** Hours on each of `days` (same order). Zero where the resource contributes nothing that day. */
export function spreadHours(
  allocation: Allocation,
  days: readonly number[],
  cap: CapacityFn,
  weeklyDays = 5,
): number[] {
  const out: number[] = new Array(days.length).fill(0)
  if (days.length === 0 || !(allocation.value > 0)) return out
  const caps = days.map(cap)
  if (allocation.kind === 'percent') {
    for (let i = 0; i < days.length; i++) out[i] = (caps[i] * allocation.value) / 100
    return out
  }
  let eff: number[] = []
  for (let i = 0; i < days.length; i++) if (caps[i] > 0) eff.push(i)
  const fallback = eff.length === 0
  if (fallback) eff = days.map((_, i) => i)
  switch (allocation.kind) {
    case 'hours_per_day':
      for (const i of eff) out[i] = allocation.value
      break
    case 'hours_per_week':
      for (const i of eff) out[i] = allocation.value / Math.max(1, weeklyDays)
      break
    case 'total_hours': {
      const weights = eff.map((i) => (fallback ? 1 : caps[i]))
      const sum = weights.reduce((x, y) => x + y, 0)
      eff.forEach((i, j) => {
        out[i] = (allocation.value * weights[j]) / sum
      })
      break
    }
  }
  return out
}

// ---- the load model ------------------------------------------------------------------------------

export interface AssignmentSpread {
  assignmentId: string
  resourceId: string
  sheetId: string
  rowId: string
  /** Day numbers and the hours on each (parallel arrays, ascending days). */
  days: number[]
  hours: number[]
}

interface ResourceLoad {
  resource: Resource
  cap: CapacityFn
  weeklyDays: number
  /** Day number -> assigned hours. */
  assigned: Map<number, number>
  spreads: AssignmentSpread[]
}

export interface LoadModel {
  readonly resources: ReadonlyMap<string, Resource>
  readonly byResource: ReadonlyMap<string, ResourceLoad>
  readonly tasks: ReadonlyMap<string, TaskFact>
  readonly assignments: readonly Assignment[]
  /** Assignments whose task is unknown (deleted) or whose resource is unknown: they carry no load. */
  readonly skipped: readonly Assignment[]
}

export function buildLoad(resources: readonly Resource[], assignments: readonly Assignment[], tasks: readonly TaskFact[]): LoadModel {
  const taskMap = new Map(tasks.map((t) => [taskKey(t.sheetId, t.rowId), t]))
  const byResource = new Map<string, ResourceLoad>()
  for (const r of resources) {
    byResource.set(r.id, { resource: r, cap: capacityFn(r), weeklyDays: workdaysPerWeek(r), assigned: new Map(), spreads: [] })
  }
  const skipped: Assignment[] = []
  for (const a of assignments) {
    const rl = byResource.get(a.resourceId)
    const task = taskMap.get(taskKey(a.sheetId, a.rowId))
    if (!rl || !task) {
      skipped.push(a)
      continue
    }
    const days = assignmentDays(a, task)
    const hours = spreadHours(a.allocation, days, rl.cap, rl.weeklyDays)
    const spread: AssignmentSpread = { assignmentId: a.id, resourceId: a.resourceId, sheetId: a.sheetId, rowId: a.rowId, days, hours }
    rl.spreads.push(spread)
    for (let i = 0; i < days.length; i++) {
      if (hours[i] > 0) rl.assigned.set(days[i], (rl.assigned.get(days[i]) ?? 0) + hours[i])
    }
  }
  return {
    resources: new Map(resources.map((r) => [r.id, r])),
    byResource,
    tasks: taskMap,
    assignments,
    skipped,
  }
}

/** Assigned and available hours of one resource on one day. */
export function dayLoad(model: LoadModel, resourceId: string, day: number): { assigned: number; available: number } {
  const rl = model.byResource.get(resourceId)
  if (!rl) return { assigned: 0, available: 0 }
  return { assigned: rl.assigned.get(day) ?? 0, available: rl.cap(day) }
}

export type LoadLevel = 'none' | 'low' | 'mid' | 'high' | 'over'

/** The heat level of assigned vs available hours: nothing, under 50%, under 85%, up to 100%, over 100%. */
export function loadLevel(assigned: number, available: number): LoadLevel {
  if (assigned <= EPS) return 'none'
  if (assigned > available + EPS) return 'over'
  const u = assigned / available
  if (u < 0.5) return 'low'
  if (u < 0.85) return 'mid'
  return 'high'
}

export interface Bucket {
  /** First day of the bucket, YYYY-MM-DD (a Monday for weeks, the 1st for months). */
  start: string
  /** Last day of the bucket, YYYY-MM-DD. */
  end: string
  assigned: number
  available: number
  /** assigned / available; null when nothing is available. */
  utilization: number | null
  /** Days inside the bucket with assigned > available. */
  overDays: number
  /** Assigned exceeds available over the bucket, or any day inside it does. */
  over: boolean
  level: LoadLevel
}

/** Day / week / month buckets covering [from, to] (whole buckets, so the first may start before `from`). */
export function bucketsFor(model: LoadModel, resourceId: string, unit: BucketUnit, from: string, to: string): Bucket[] {
  const rl = model.byResource.get(resourceId)
  const out: Bucket[] = []
  const last = dayNumber(to)
  for (let s = bucketStartDay(unit, dayNumber(from)); s <= last; ) {
    const next = nextBucketStartDay(unit, s)
    let assigned = 0
    let available = 0
    let overDays = 0
    if (rl) {
      for (let d = s; d < next; d++) {
        const a = rl.assigned.get(d) ?? 0
        const c = rl.cap(d)
        assigned += a
        available += c
        if (a > c + EPS) overDays++
      }
    }
    const over = overDays > 0 || assigned > available + EPS
    out.push({
      start: isoOfDay(s),
      end: isoOfDay(next - 1),
      assigned,
      available,
      utilization: available > 0 ? assigned / available : null,
      overDays,
      over,
      level: over ? 'over' : loadLevel(assigned, available),
    })
    s = next
  }
  return out
}

export interface Contribution {
  assignmentId: string
  sheetId: string
  rowId: string
  /** Hours this assignment puts on the resource within the window. */
  hours: number
  /** Working days with hours inside the window. */
  days: number
}

/** The assignments behind a number: what each puts on the resource in [from, to], biggest first. */
export function contributions(model: LoadModel, resourceId: string, from: string, to: string): Contribution[] {
  const rl = model.byResource.get(resourceId)
  if (!rl) return []
  const a = dayNumber(from)
  const b = dayNumber(to)
  const out: Contribution[] = []
  for (const s of rl.spreads) {
    let hours = 0
    let days = 0
    for (let i = 0; i < s.days.length; i++) {
      if (s.days[i] >= a && s.days[i] <= b && s.hours[i] > 0) {
        hours += s.hours[i]
        days++
      }
    }
    if (hours > 0) out.push({ assignmentId: s.assignmentId, sheetId: s.sheetId, rowId: s.rowId, hours, days })
  }
  return out.sort((x, y) => y.hours - x.hours)
}

export interface Utilization {
  resourceId: string
  assigned: number
  available: number
  /** assigned / available; null when nothing is available. */
  utilization: number | null
  overDays: number
  /** Hours above capacity, summed over the over-allocated days. */
  excessHours: number
  /** The most loaded day (assigned / available, or the biggest excess when available is 0). */
  peak: { day: string; assigned: number; available: number } | null
}

/** Totals for one resource over [from, to] (calendar days, inclusive). */
export function utilizationOf(model: LoadModel, resourceId: string, from: string, to: string): Utilization {
  const rl = model.byResource.get(resourceId)
  const out: Utilization = { resourceId, assigned: 0, available: 0, utilization: null, overDays: 0, excessHours: 0, peak: null }
  if (!rl) return out
  const last = dayNumber(to)
  let peakScore = -1
  for (let d = dayNumber(from); d <= last; d++) {
    const a = rl.assigned.get(d) ?? 0
    const c = rl.cap(d)
    out.assigned += a
    out.available += c
    if (a > c + EPS) {
      out.overDays++
      out.excessHours += a - c
    }
    if (a > 0) {
      const score = c > 0 ? a / c : Number.MAX_SAFE_INTEGER
      if (score > peakScore) {
        peakScore = score
        out.peak = { day: isoOfDay(d), assigned: a, available: c }
      }
    }
  }
  out.utilization = out.available > 0 ? out.assigned / out.available : null
  return out
}

export function utilizationSummary(model: LoadModel, from: string, to: string, resourceIds?: readonly string[]): Utilization[] {
  const ids = resourceIds ?? [...model.byResource.keys()]
  return ids.map((id) => utilizationOf(model, id, from, to))
}

// ---- find a resource ---------------------------------------------------------------------------

export interface AvailabilityQuery {
  from: string
  to: string
  /** Needed hours on every working day... */
  hoursPerDay?: number
  /** ...or this much of the resource's capacity on every day... */
  percent?: number
  /** ...or this many hours in total over the window. With none of the three any free time counts. */
  totalHours?: number
  department?: string
  kind?: ResourceKind
  /** Every listed skill must be present (case-insensitive). */
  skills?: readonly string[]
  excludeIds?: readonly string[]
}

export interface Availability {
  resourceId: string
  /** Working days (capacity > 0) in the window. */
  workingDays: number
  availableHours: number
  assignedHours: number
  /** Sum over working days of max(0, available - assigned). */
  freeHours: number
  /** The smallest free hours on any working day in the window. */
  minFreePerDay: number
  fits: boolean
}

/** Who is free in a window, best fit first (those that fit, then the most free hours). */
export function findAvailable(model: LoadModel, query: AvailabilityQuery): Availability[] {
  const wantSkills = (query.skills ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean)
  const exclude = new Set(query.excludeIds ?? [])
  const a = dayNumber(query.from)
  const b = dayNumber(query.to)
  const out: Availability[] = []
  for (const [id, rl] of model.byResource) {
    const r = rl.resource
    if (exclude.has(id)) continue
    if (query.department && (r.department ?? '').toLowerCase() !== query.department.toLowerCase()) continue
    if (query.kind && r.kind !== query.kind) continue
    if (wantSkills.length > 0) {
      const have = new Set(r.skills.map((s) => s.toLowerCase()))
      if (!wantSkills.every((s) => have.has(s))) continue
    }
    let workingDays = 0
    let available = 0
    let assigned = 0
    let free = 0
    let minFree = Infinity
    let fits = true
    for (let d = a; d <= b; d++) {
      const c = rl.cap(d)
      const used = rl.assigned.get(d) ?? 0
      assigned += used
      if (c <= 0) continue
      workingDays++
      available += c
      const f = Math.max(0, c - used)
      free += f
      if (f < minFree) minFree = f
      if (query.hoursPerDay !== undefined && f + EPS < query.hoursPerDay) fits = false
      if (query.percent !== undefined && f + EPS < (c * query.percent) / 100) fits = false
    }
    if (workingDays === 0) {
      minFree = 0
      fits = false
    }
    if (query.totalHours !== undefined && free + EPS < query.totalHours) fits = false
    if (query.hoursPerDay === undefined && query.percent === undefined && query.totalHours === undefined) fits = free > EPS
    out.push({ resourceId: id, workingDays, availableHours: available, assignedHours: assigned, freeHours: free, minFreePerDay: minFree === Infinity ? 0 : minFree, fits })
  }
  return out.sort((x, y) => Number(y.fits) - Number(x.fits) || y.freeHours - x.freeHours || x.resourceId.localeCompare(y.resourceId))
}

/** Over-allocated days of a resource over a window (day numbers with assigned > available). */
export function overAllocatedDays(model: LoadModel, resourceId: string, from: string, to: string): number[] {
  const rl = model.byResource.get(resourceId)
  if (!rl) return []
  const out: number[] = []
  const lo = dayNumber(from)
  const hi = dayNumber(to)
  for (const [d, a] of rl.assigned) if (d >= lo && d <= hi && a > rl.cap(d) + EPS) out.push(d)
  return out.sort((x, y) => x - y)
}

/**
 * What allocating `allocation` on `task` to `resource` would do: the hours per day it adds and the
 * days that would end up over capacity. Used by the assign panel before the user saves.
 */
export function previewAssignment(
  model: LoadModel,
  resourceId: string,
  task: TaskFact,
  allocation: Allocation,
  overrides: { startDate: string | null; endDate: string | null } = { startDate: null, endDate: null },
  /** Hours the same assignment already puts on the resource (when editing), to avoid counting it twice. */
  replacing?: string,
): { days: number[]; hours: number[]; totalHours: number; overDays: number[] } {
  const rl = model.byResource.get(resourceId)
  if (!rl) return { days: [], hours: [], totalHours: 0, overDays: [] }
  const days = assignmentDays(overrides, task)
  const hours = spreadHours(allocation, days, rl.cap, rl.weeklyDays)
  const existing = replacing ? rl.spreads.find((s) => s.assignmentId === replacing) : undefined
  const minus = new Map<number, number>()
  if (existing) existing.days.forEach((d, i) => minus.set(d, existing.hours[i]))
  const overDays: number[] = []
  for (let i = 0; i < days.length; i++) {
    const total = (rl.assigned.get(days[i]) ?? 0) - (minus.get(days[i]) ?? 0) + hours[i]
    if (hours[i] > 0 && total > rl.cap(days[i]) + EPS) overDays.push(days[i])
  }
  return { days, hours, totalHours: hours.reduce((x, y) => x + y, 0), overDays }
}
