import { addWorkingDays, isWorkingDay, previousWorkingDay, shiftIso } from './calendar'
import {
  endFromStart,
  lagDaysOf,
  startFromEnd,
  type SchedDep,
  type SchedRow,
  type ScheduleResult,
} from './schedule'
import type { Calendar } from './types'

/** Critical-path facts for one row. Floats are in working days. */
export interface CriticalInfo {
  /** The latest the row may start without delaying the project finish. */
  lateStart: string
  /** The latest the row may finish without delaying the project finish. */
  lateFinish: string
  /** Working days the row can slip before the project finish moves. */
  totalFloat: number
  /** Working days the row can slip before any successor's early dates move. */
  freeFloat: number
  /** Total float is zero: slipping the row moves the project finish. */
  critical: boolean
}

export interface CriticalPathResult {
  byRow: Record<string, CriticalInfo>
  /** The latest end date of any scheduled row; null when nothing is scheduled. */
  projectEnd: string | null
  /** `depKey(pred, succ)` of every dependency that drives its successor and joins two critical rows. */
  criticalDeps: string[]
}

export function depKey(predecessorId: string, successorId: string): string {
  return `${predecessorId}->${successorId}`
}

const DAY_MS = 24 * 60 * 60 * 1000
const dayNumber = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS)

/**
 * Counts working days between two dates in O(1) after a linear pass over [from, to].
 * `count(a, b)` is the number of working days in (a, b], negative when b is before a.
 */
function workingDayCounter(cal: Calendar, from: string, to: string) {
  const base = dayNumber(from)
  const span = dayNumber(to) - base
  const upTo: number[] = new Array(span + 1)
  let total = 0
  for (let i = 0, day = from; i <= span; i++, day = shiftIso(day, 1)) {
    if (isWorkingDay(cal, day)) total++
    upTo[i] = total
  }
  const at = (iso: string) => upTo[Math.min(Math.max(dayNumber(iso) - base, 0), span)]
  return (a: string, b: string) => at(b) - at(a)
}

/**
 * The latest start a predecessor may have so that `dep` still holds, given its successor occupies
 * [succStart, succEnd]. This inverts the forward pass in `schedule.ts` one link type at a time, so
 * the result is exactly the last date the forward pass would not push the successor past.
 * Used with the successor's late dates (total float) and early dates (free float).
 */
function latestPredecessorStart(
  dep: SchedDep,
  pred: { durationDays: number; elapsed: boolean },
  succStart: string,
  succEnd: string,
  cal: Calendar,
): string {
  const lag = lagDaysOf(dep, cal)
  const endBound = previousWorkingDay(cal, succEnd)
  switch (dep.type) {
    case 'FS': {
      // successor start >= first working day after pred end, plus lag
      const firstAllowed = addWorkingDays(cal, succStart, -lag)
      const lastEnd = shiftIso(firstAllowed, -1)
      const end = pred.elapsed ? lastEnd : previousWorkingDay(cal, lastEnd)
      return previousWorkingDay(cal, startFromEnd(end, pred.durationDays, pred.elapsed, cal))
    }
    case 'SS':
      return addWorkingDays(cal, succStart, -lag)
    case 'FF': {
      const lastEnd = lag === 0 ? endBound : addWorkingDays(cal, endBound, -lag)
      return previousWorkingDay(cal, startFromEnd(lastEnd, pred.durationDays, pred.elapsed, cal))
    }
    case 'SF':
      return addWorkingDays(cal, endBound, -lag)
  }
}

/**
 * Backward pass: late dates, total and free float, and the critical path, for a schedule produced
 * by `schedule()` from the same rows, dependencies and calendar. Pure; leaves `schedule()` alone.
 *
 * Only leaf rows that were scheduled take part in the network (summary rows take their values from
 * their leaves; rows in or behind a dependency cycle have no schedule and are skipped). The project
 * finish is the latest end of any row, and every row must also finish by then, so total float is the
 * number of working days a row can slip before that date moves.
 *
 * Elapsed (calendar-day) rows are handled conservatively: where a late date would fall on a
 * non-working day it is taken as the working day before, so their float may be a day short, never long.
 */
export function analyzeCriticalPath(
  rows: SchedRow[],
  deps: SchedDep[],
  cal: Calendar,
  result: ScheduleResult,
): CriticalPathResult {
  const scheduled = result.byRow
  const rowById = new Map(rows.map((r) => [r.id, r]))
  const childrenOf = new Map<string, string[]>()
  for (const r of rows) {
    if (r.parentId !== null && rowById.has(r.parentId)) {
      const list = childrenOf.get(r.parentId) ?? []
      list.push(r.id)
      childrenOf.set(r.parentId, list)
    }
  }
  const isLeaf = (id: string) => !childrenOf.has(id)
  const leaves = rows.filter((r) => isLeaf(r.id) && scheduled[r.id])
  if (leaves.length === 0) return { byRow: {}, projectEnd: null, criticalDeps: [] }

  const leafIds = new Set(leaves.map((r) => r.id))
  const edges = deps.filter((d) => leafIds.has(d.predecessorId) && leafIds.has(d.successorId))
  const outgoing = new Map<string, SchedDep[]>()
  const indegree = new Map<string, number>()
  for (const r of leaves) {
    outgoing.set(r.id, [])
    indegree.set(r.id, 0)
  }
  for (const d of edges) {
    outgoing.get(d.predecessorId)!.push(d)
    indegree.set(d.successorId, indegree.get(d.successorId)! + 1)
  }
  // Topological order of the leaf network (acyclic: cycle members have no schedule).
  const order: string[] = leaves.filter((r) => indegree.get(r.id) === 0).map((r) => r.id)
  for (let i = 0; i < order.length; i++) {
    for (const d of outgoing.get(order[i])!) {
      const n = indegree.get(d.successorId)! - 1
      indegree.set(d.successorId, n)
      if (n === 0) order.push(d.successorId)
    }
  }
  if (order.length !== leaves.length) return { byRow: {}, projectEnd: null, criticalDeps: [] }

  let projectEnd = scheduled[leaves[0].id].end
  let earliest = scheduled[leaves[0].id].start
  for (const r of leaves) {
    const s = scheduled[r.id]
    if (s.end > projectEnd) projectEnd = s.end
    if (s.start < earliest) earliest = s.start
  }
  const count = workingDayCounter(cal, earliest, projectEnd)

  const info = (id: string) => ({
    durationDays: scheduled[id].durationDays,
    elapsed: rowById.get(id)!.elapsed,
  })

  // Backward pass, successors first.
  const lateStart = new Map<string, string>()
  const lateFinish = new Map<string, string>()
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]
    const { durationDays, elapsed } = info(id)
    // Every row must also finish by the project finish.
    let ls = previousWorkingDay(cal, startFromEnd(projectEnd, durationDays, elapsed, cal))
    for (const d of outgoing.get(id)!) {
      const bound = latestPredecessorStart(d, info(id), lateStart.get(d.successorId)!, lateFinish.get(d.successorId)!, cal)
      if (bound < ls) ls = bound
    }
    lateStart.set(id, ls)
    lateFinish.set(id, endFromStart(ls, durationDays, elapsed, cal))
  }

  const byRow: Record<string, CriticalInfo> = {}
  const tightDeps: SchedDep[] = []
  for (const r of leaves) {
    const s = scheduled[r.id]
    const totalFloat = count(s.start, lateStart.get(r.id)!)
    let freeFloat = totalFloat
    const successors = outgoing.get(r.id)!
    if (successors.length > 0) {
      freeFloat = Infinity
      for (const d of successors) {
        const succ = scheduled[d.successorId]
        const slack = count(s.start, latestPredecessorStart(d, info(r.id), succ.start, succ.end, cal))
        if (slack === 0) tightDeps.push(d)
        if (slack < freeFloat) freeFloat = slack
      }
      // A row that only feeds start-based links could slip past the project finish without moving
      // a successor; it still may not slip further than its total float.
      freeFloat = Math.min(freeFloat, totalFloat)
    }
    byRow[r.id] = {
      lateStart: lateStart.get(r.id)!,
      lateFinish: lateFinish.get(r.id)!,
      totalFloat,
      freeFloat,
      critical: totalFloat <= 0,
    }
  }

  // Summary rows: the tightest of their leaves.
  const summarize = (id: string): CriticalInfo | null => {
    if (isLeaf(id)) return byRow[id] ?? null
    const parts = childrenOf.get(id)!.map(summarize).filter((x): x is CriticalInfo => x !== null)
    if (parts.length === 0) return null
    const merged: CriticalInfo = {
      lateStart: parts.reduce((m, p) => (p.lateStart < m ? p.lateStart : m), parts[0].lateStart),
      lateFinish: parts.reduce((m, p) => (p.lateFinish > m ? p.lateFinish : m), parts[0].lateFinish),
      totalFloat: Math.min(...parts.map((p) => p.totalFloat)),
      freeFloat: Math.min(...parts.map((p) => p.freeFloat)),
      critical: parts.some((p) => p.critical),
    }
    byRow[id] = merged
    return merged
  }
  for (const r of rows) if (!isLeaf(r.id) && !(r.id in byRow)) summarize(r.id)

  const criticalDeps = tightDeps
    .filter((d) => byRow[d.predecessorId].critical && byRow[d.successorId].critical)
    .map((d) => depKey(d.predecessorId, d.successorId))
  return { byRow, projectEnd, criticalDeps }
}
