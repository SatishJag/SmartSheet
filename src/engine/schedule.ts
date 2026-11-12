import { addWorkingDays, isWorkingDay, nextWorkingDay, shiftIso } from './calendar'
import { findCycleGroups } from './cycles'
import { toWorkingDays } from './duration'
import type { Calendar, DepType } from './types'

export interface SchedRow {
  id: string
  parentId: string | null
  durationMinutes: number
  elapsed: boolean
  manualStart: string | null
  percentComplete: number
}

export interface SchedDep {
  predecessorId: string
  successorId: string
  type: DepType
  lagMinutes: number
}

export interface Scheduled {
  start: string
  end: string
  durationDays: number
  percentComplete: number
}

export interface ScheduleError {
  rowId: string
  message: string
}

export interface ScheduleResult {
  byRow: Record<string, Scheduled>
  errors: ScheduleError[]
  /** Ids of the tasks on the critical path: zero float, a delay in any of them delays the finish. */
  critical: string[]
}

/** Day count for a row: calendar days if elapsed, else working days. 0 minutes is a milestone. */
function durationDaysOf(row: SchedRow, cal: Calendar): number {
  if (row.durationMinutes <= 0) return 0
  return Math.max(1, toWorkingDays({ minutes: row.durationMinutes, elapsed: row.elapsed }, cal.hoursPerDay))
}

function lagDaysOf(dep: SchedDep, cal: Calendar): number {
  return Math.round(dep.lagMinutes / (cal.hoursPerDay * 60))
}

/** End date for a row of durationDays starting on start (a working day). */
function endFromStart(start: string, durationDays: number, elapsed: boolean, cal: Calendar): string {
  if (durationDays <= 1) return start
  return elapsed ? shiftIso(start, durationDays - 1) : addWorkingDays(cal, start, durationDays - 1)
}

/** Start date for a row of durationDays ending on end (a working day). */
function startFromEnd(end: string, durationDays: number, elapsed: boolean, cal: Calendar): string {
  if (durationDays <= 1) return end
  return elapsed ? shiftIso(end, -(durationDays - 1)) : addWorkingDays(cal, end, -(durationDays - 1))
}

/** The first working day strictly after iso (iso itself may be a non-working day). */
function firstWorkingDayAfter(cal: Calendar, iso: string): string {
  return nextWorkingDay(cal, shiftIso(iso, 1))
}

/**
 * The working day lag working days from iso. lag 0 is iso itself, or the next working day when iso
 * is not one. addWorkingDays counts working days strictly after/before iso, so it is correct for a
 * non-working iso (an elapsed task's end) as well.
 */
function offsetWorkingDays(cal: Calendar, iso: string, lag: number): string {
  return lag === 0 ? nextWorkingDay(cal, iso) : addWorkingDays(cal, iso, lag)
}

/**
 * Candidate start for the successor implied by one dependency on an already-scheduled predecessor.
 * A predecessor's end can be a non-working day (elapsed durations); its start is always a working
 * day (manual starts and dependency starts are moved to one; rollups take a child's start), so only
 * the FS and FF branches need care.
 */
function candidateStart(
  dep: SchedDep,
  pred: Scheduled,
  durationDays: number,
  elapsed: boolean,
  cal: Calendar,
): string {
  const lag = lagDaysOf(dep, cal)
  switch (dep.type) {
    case 'FS':
      return addWorkingDays(cal, firstWorkingDayAfter(cal, pred.end), lag)
    case 'SS':
      return addWorkingDays(cal, nextWorkingDay(cal, pred.start), lag)
    case 'FF':
      return startFromEnd(offsetWorkingDays(cal, pred.end, lag), durationDays, elapsed, cal)
    case 'SF':
      return startFromEnd(addWorkingDays(cal, nextWorkingDay(cal, pred.start), lag), durationDays, elapsed, cal)
  }
}

/**
 * Kahn's algorithm over the given edges (dependencies plus child -> parent).
 * Ties are broken by input row order.
 * Rows that cannot be ordered (in or downstream of a cycle) are returned in leftover.
 */
function topologicalOrder(
  rows: SchedRow[],
  edges: SchedDep[],
): { order: string[]; leftover: string[] } {
  const indegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const r of rows) {
    indegree.set(r.id, 0)
    outgoing.set(r.id, [])
  }
  for (const e of edges) {
    outgoing.get(e.predecessorId)!.push(e.successorId)
    indegree.set(e.successorId, indegree.get(e.successorId)! + 1)
  }

  const queue = rows.filter((r) => indegree.get(r.id) === 0).map((r) => r.id)
  const order: string[] = []
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    order.push(id)
    for (const succ of outgoing.get(id)!) {
      const n = indegree.get(succ)! - 1
      indegree.set(succ, n)
      if (n === 0) queue.push(succ)
    }
  }
  const placed = new Set(order)
  return { order, leftover: rows.filter((r) => !placed.has(r.id)).map((r) => r.id) }
}

/** Schedules one row given its (valid) incoming dependencies and the rows already scheduled. */
function scheduleRow(
  row: SchedRow,
  deps: SchedDep[],
  byRow: Record<string, Scheduled>,
  cal: Calendar,
): Scheduled | ScheduleError {
  const durationDays = durationDaysOf(row, cal)
  let start: string | null = null

  if (deps.length > 0) {
    for (const d of deps) {
      const pred = byRow[d.predecessorId]
      if (!pred) return { rowId: row.id, message: `Predecessor ${d.predecessorId} could not be scheduled` }
      const candidate = nextWorkingDay(cal, candidateStart(d, pred, durationDays, row.elapsed, cal))
      if (start === null || candidate > start) start = candidate
    }
  } else if (row.manualStart) {
    start = nextWorkingDay(cal, row.manualStart)
  } else {
    return { rowId: row.id, message: 'No start date' }
  }

  const end = endFromStart(start!, durationDays, row.elapsed, cal)
  return { start: start!, end, durationDays, percentComplete: row.percentComplete }
}

/** Number of working days from start to end inclusive. */
function workingDaysBetween(cal: Calendar, start: string, end: string): number {
  let count = 0
  for (let day = start; day <= end; day = shiftIso(day, 1)) {
    if (isWorkingDay(cal, day)) count++
  }
  return count
}

/**
 * Rolls a parent row up from its scheduled children. Returns null if none are scheduled.
 * Percent is weighted by child duration; if every child is a milestone it is the plain average.
 */
function rollUp(children: Scheduled[], cal: Calendar): Scheduled | null {
  if (children.length === 0) return null
  let start = children[0].start
  let end = children[0].end
  let weight = 0
  let weighted = 0
  let percentSum = 0
  for (const c of children) {
    if (c.start < start) start = c.start
    if (c.end > end) end = c.end
    weight += c.durationDays
    weighted += c.durationDays * c.percentComplete
    percentSum += c.percentComplete
  }
  const percentComplete = Math.round(weight > 0 ? weighted / weight : percentSum / children.length)
  return { start, end, durationDays: workingDaysBetween(cal, start, end), percentComplete }
}

/**
 * Critical path: the leaf tasks reachable backwards, through driving dependencies only, from the
 * tasks that finish last. A dependency drives when it alone sets its successor's start.
 * shortcut: only the finish-driving chains count; near-critical (low float) tasks are not shown.
 */
function criticalPath(
  rows: SchedRow[],
  incoming: Map<string, SchedDep[]>,
  childrenOf: Map<string, string[]>,
  byRow: Record<string, Scheduled>,
  cal: Calendar,
): string[] {
  const leaves = rows.filter((r) => !childrenOf.has(r.id) && byRow[r.id])
  if (leaves.length === 0) return []
  const finish = leaves.reduce((m, r) => (byRow[r.id].end > m ? byRow[r.id].end : m), '')
  const rowById = new Map(rows.map((r) => [r.id, r]))
  const critical = new Set<string>()
  const stack = leaves.filter((r) => byRow[r.id].end === finish).map((r) => r.id)
  while (stack.length > 0) {
    const id = stack.pop()!
    if (critical.has(id)) continue
    critical.add(id)
    const row = rowById.get(id)!
    const me = byRow[id]
    for (const d of incoming.get(id) ?? []) {
      const pred = byRow[d.predecessorId]
      if (pred && nextWorkingDay(cal, candidateStart(d, pred, me.durationDays, row.elapsed, cal)) === me.start) {
        stack.push(d.predecessorId)
      }
    }
  }
  // A single task is not a path: nothing is linked to it, so there is nothing to highlight.
  return critical.size < 2 ? [] : rows.filter((r) => critical.has(r.id)).map((r) => r.id)
}

/**
 * Forward pass plus parent rollups: computes start, end, duration and percent for every row
 * from manual starts, dependencies and (for parent rows) their children.
 * Rows in or downstream of a dependency cycle are not scheduled and get an error.
 */
export function schedule(rows: SchedRow[], deps: SchedDep[], cal: Calendar): ScheduleResult {
  const errors: ScheduleError[] = []
  const byRow: Record<string, Scheduled> = {}
  const rowById = new Map(rows.map((r) => [r.id, r]))

  // A parent row is the parentId of at least one row.
  const childrenOf = new Map<string, string[]>()
  for (const r of rows) {
    if (r.parentId === null || !rowById.has(r.parentId)) continue
    const list = childrenOf.get(r.parentId) ?? []
    list.push(r.id)
    childrenOf.set(r.parentId, list)
  }

  // Keep only dependencies whose rows exist; report unknown predecessors on the successor.
  // Dependencies into a parent row are ignored: its dates come from its children.
  const incoming = new Map<string, SchedDep[]>()
  const validDeps: SchedDep[] = []
  const summaryWithPredecessor = new Set<string>()
  for (const d of deps) {
    if (!rowById.has(d.successorId)) continue
    if (!rowById.has(d.predecessorId)) {
      errors.push({ rowId: d.successorId, message: `Unknown predecessor ${d.predecessorId}` })
      continue
    }
    if (childrenOf.has(d.successorId)) {
      if (!summaryWithPredecessor.has(d.successorId)) {
        summaryWithPredecessor.add(d.successorId)
        errors.push({ rowId: d.successorId, message: 'Summary rows cannot have predecessors' })
      }
      continue
    }
    const list = incoming.get(d.successorId) ?? []
    list.push(d)
    incoming.set(d.successorId, list)
    validDeps.push(d)
  }

  // Every child must be ordered before its parent, so those are edges too.
  const edges = [...validDeps]
  for (const [parentId, childIds] of childrenOf) {
    for (const childId of childIds) {
      edges.push({ predecessorId: childId, successorId: parentId, type: 'FS', lagMinutes: 0 })
    }
  }

  const inCycle = new Set<string>()
  for (const group of findCycleGroups(edges)) {
    const message = `Dependency cycle: ${[...group.path, group.path[0]].join(' -> ')}`
    for (const id of group.members) {
      inCycle.add(id)
      errors.push({ rowId: id, message })
    }
  }

  const { order, leftover } = topologicalOrder(rows, edges)

  for (const id of order) {
    const row = rowById.get(id)!
    const childIds = childrenOf.get(id)
    if (childIds) {
      const scheduledChildren = childIds.flatMap((c) => (byRow[c] ? [byRow[c]] : []))
      const rolled = rollUp(scheduledChildren, cal)
      if (rolled) byRow[id] = rolled
      else errors.push({ rowId: id, message: 'No scheduled children' })
      continue
    }
    const result = scheduleRow(row, incoming.get(id) ?? [], byRow, cal)
    if ('rowId' in result) errors.push(result)
    else byRow[id] = result
  }
  for (const id of leftover) {
    if (!inCycle.has(id)) errors.push({ rowId: id, message: 'Depends on a row in a dependency cycle' })
  }

  return { byRow, errors, critical: criticalPath(rows, incoming, childrenOf, byRow, cal) }
}
