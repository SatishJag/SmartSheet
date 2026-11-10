import { addWorkingDays, nextWorkingDay, shiftIso } from './calendar'
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

/** Candidate start for the successor implied by one dependency on an already-scheduled predecessor. */
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
      return addWorkingDays(cal, nextWorkingDay(cal, pred.end), 1 + lag)
    case 'SS':
      return addWorkingDays(cal, nextWorkingDay(cal, pred.start), lag)
    case 'FF':
      return startFromEnd(addWorkingDays(cal, nextWorkingDay(cal, pred.end), lag), durationDays, elapsed, cal)
    case 'SF':
      return startFromEnd(addWorkingDays(cal, nextWorkingDay(cal, pred.start), lag), durationDays, elapsed, cal)
  }
}

/**
 * Kahn's algorithm over the valid dependencies. Ties are broken by input row order.
 * Rows that cannot be ordered (in or downstream of a cycle) are returned in leftover.
 */
function topologicalOrder(
  rows: SchedRow[],
  incoming: Map<string, SchedDep[]>,
): { order: string[]; leftover: string[] } {
  const indegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const r of rows) {
    indegree.set(r.id, incoming.get(r.id)?.length ?? 0)
    outgoing.set(r.id, [])
  }
  for (const deps of incoming.values()) {
    for (const d of deps) outgoing.get(d.predecessorId)!.push(d.successorId)
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

/**
 * Forward pass: computes start, end and duration for every row from manual starts
 * and dependencies. Parent rollups are not applied here.
 */
export function schedule(rows: SchedRow[], deps: SchedDep[], cal: Calendar): ScheduleResult {
  const errors: ScheduleError[] = []
  const byRow: Record<string, Scheduled> = {}
  const rowById = new Map(rows.map((r) => [r.id, r]))

  // Keep only dependencies whose rows exist; report unknown predecessors on the successor.
  const incoming = new Map<string, SchedDep[]>()
  for (const d of deps) {
    if (!rowById.has(d.successorId)) continue
    if (!rowById.has(d.predecessorId)) {
      errors.push({ rowId: d.successorId, message: `Unknown predecessor ${d.predecessorId}` })
      continue
    }
    const list = incoming.get(d.successorId) ?? []
    list.push(d)
    incoming.set(d.successorId, list)
  }

  const { order, leftover } = topologicalOrder(rows, incoming)

  for (const id of order) {
    const result = scheduleRow(rowById.get(id)!, incoming.get(id) ?? [], byRow, cal)
    if ('rowId' in result) errors.push(result)
    else byRow[id] = result
  }
  for (const id of leftover) errors.push({ rowId: id, message: 'Dependency cycle' })

  return { byRow, errors }
}
