/**
 * Leveling suggestions: which tasks could move later, within their float, to remove an
 * over-allocation. Pure and advisory: nothing is applied, the user decides.
 *
 * Greedy and sequential: over-allocated resource-days are visited worst resource first; for each
 * still-over day the tasks on it that have float are tried (largest float first) at a delay of
 * 1, 2, ... working days. A delay is accepted when it clears that day, makes no resource worse
 * (no new over-allocated day and no more excess on any day), and stays within the task's float.
 * Delays inside free float come first (successors do not move); only when none works is total float
 * used (successors shift, the project end does not). An accepted move is applied to the working
 * state, so later suggestions see it. Assignments with their own dates do not follow the task and
 * are left where they are.
 */

import { addWorkingDays } from '../engine/calendar'
import { endFromStart } from '../engine/schedule'
import {
  EPS,
  buildLoad,
  spreadHours,
  taskKey,
  workingDayNumbers,
  type Assignment,
  type CapacityFn,
  type LoadModel,
  type Resource,
  type TaskFact,
} from './engine'

export interface LevelingSuggestion {
  sheetId: string
  rowId: string
  taskName: string
  /** Working days (of the task's sheet calendar) to delay the task. */
  shiftDays: number
  newStart: string
  newEnd: string
  /** The resource whose over-allocation motivated the move, and how many of its days it clears. */
  resourceId: string
  clearedDays: number
  /** True when the delay is beyond free float: successors move (the project end does not). */
  knockOn: boolean
}

export interface LevelingResult {
  suggestions: LevelingSuggestion[]
  /** Resources still over-allocated after all suggestions, with the days left. */
  unresolved: { resourceId: string; overDays: number }[]
  /** True when the search stopped at `maxSuggestions` or `maxEvaluations`. */
  truncated: boolean
}

export interface LevelingOptions {
  /** Only these resources are levelled (default: all). */
  resourceIds?: readonly string[]
  /** Only over-allocations on or after this date. */
  from?: string
  to?: string
  maxSuggestions?: number
  /** Cap on candidate shifts tried, to bound the work on huge plans. */
  maxEvaluations?: number
  /** Longest delay tried in working days. */
  maxShift?: number
}

interface Entry {
  assignment: Assignment
  resourceId: string
  cap: CapacityFn
  weeklyDays: number
  days: number[]
  hours: number[]
  follows: boolean
}

export function suggestLeveling(
  resources: readonly Resource[],
  assignments: readonly Assignment[],
  tasks: readonly TaskFact[],
  options: LevelingOptions = {},
): LevelingResult {
  const maxSuggestions = options.maxSuggestions ?? 100
  const maxEvaluations = options.maxEvaluations ?? 200_000
  const maxShift = options.maxShift ?? 60
  const model: LoadModel = buildLoad(resources, assignments, tasks)
  const wanted = options.resourceIds ? new Set(options.resourceIds) : null
  const lo = options.from ? Date.parse(`${options.from}T00:00:00Z`) / 86_400_000 : -Infinity
  const hi = options.to ? Date.parse(`${options.to}T00:00:00Z`) / 86_400_000 : Infinity

  // Working state: every assignment's current spread, hours per resource-day, and entries per task.
  const day = new Map<string, Map<number, number>>()
  const entriesByTask = new Map<string, Entry[]>()
  const entriesByResource = new Map<string, Entry[]>()
  for (const [rid, rl] of model.byResource) {
    day.set(rid, new Map(rl.assigned))
    entriesByResource.set(rid, [])
  }
  const spreadById = new Map<string, { days: number[]; hours: number[] }>()
  for (const rl of model.byResource.values()) for (const s of rl.spreads) spreadById.set(s.assignmentId, s)
  for (const a of assignments) {
    const rl = model.byResource.get(a.resourceId)
    const task = model.tasks.get(taskKey(a.sheetId, a.rowId))
    if (!rl || !task) continue
    const spread = spreadById.get(a.id)!
    const entry: Entry = {
      assignment: a,
      resourceId: a.resourceId,
      cap: rl.cap,
      weeklyDays: rl.weeklyDays,
      days: spread.days,
      hours: spread.hours,
      follows: a.startDate === null && a.endDate === null,
    }
    const key = taskKey(a.sheetId, a.rowId)
    ;(entriesByTask.get(key) ?? entriesByTask.set(key, []).get(key)!).push(entry)
    entriesByResource.get(a.resourceId)!.push(entry)
  }

  const isOver = (rid: string, d: number, extra = 0) => (day.get(rid)!.get(d) ?? 0) + extra > model.byResource.get(rid)!.cap(d) + EPS
  const excessOf = (rid: string, d: number, hoursNow: number) => Math.max(0, hoursNow - model.byResource.get(rid)!.cap(d))

  const overList = (rid: string) => {
    const out: number[] = []
    for (const [d, h] of day.get(rid)!) if (d >= lo && d <= hi && h > model.byResource.get(rid)!.cap(d) + EPS) out.push(d)
    return out.sort((x, y) => x - y)
  }

  const totalExcess = (rid: string) => {
    let e = 0
    for (const d of overList(rid)) e += (day.get(rid)!.get(d) ?? 0) - model.byResource.get(rid)!.cap(d)
    return e
  }

  const targets = [...model.byResource.keys()].filter((id) => !wanted || wanted.has(id))
  const ranked = targets
    .map((id) => ({ id, excess: totalExcess(id) }))
    .filter((x) => x.excess > EPS)
    .sort((a, b) => b.excess - a.excess || a.id.localeCompare(b.id))

  const suggestions: LevelingSuggestion[] = []
  const moved = new Set<string>()
  let evaluations = 0
  let truncated = false

  /** The new hours per (resource, day) if `task` is delayed by `k` working days, or null if impossible. */
  function shifted(task: TaskFact, k: number) {
    const newStart = addWorkingDays(task.calendar, task.start, k)
    const newEnd = endFromStart(newStart, task.durationDays, task.elapsed, task.calendar)
    const newDays = workingDayNumbers(newStart, newEnd, task.calendar)
    return { newStart, newEnd, newDays }
  }

  function tryShift(key: string, task: TaskFact, k: number, rid: string, d: number) {
    evaluations++
    const entries = (entriesByTask.get(key) ?? []).filter((e) => e.follows)
    const { newStart, newEnd, newDays } = shifted(task, k)
    // Net change per resource-day.
    const delta = new Map<string, Map<number, number>>()
    const add = (r: string, dd: number, h: number) => {
      const m = delta.get(r) ?? delta.set(r, new Map()).get(r)!
      m.set(dd, (m.get(dd) ?? 0) + h)
    }
    const planned: { entry: Entry; days: number[]; hours: number[] }[] = []
    for (const e of entries) {
      e.days.forEach((dd, i) => e.hours[i] > 0 && add(e.resourceId, dd, -e.hours[i]))
      const hours = spreadHours(e.assignment.allocation, newDays, e.cap, e.weeklyDays)
      newDays.forEach((dd, i) => hours[i] > 0 && add(e.resourceId, dd, hours[i]))
      planned.push({ entry: e, days: newDays, hours })
    }
    // Accept only a delay that makes nothing worse anywhere and takes the task off *every* over-allocated
    // day it currently adds to for this resource (a partial fix would leave the task stuck, since each
    // task is moved at most once). Days still over because of other tasks are left to later suggestions.
    let cleared = 0
    for (const [r, m] of delta) {
      for (const [dd, dh] of m) {
        const before = day.get(r)!.get(dd) ?? 0
        if (excessOf(r, dd, before + dh) > excessOf(r, dd, before) + EPS) return null
      }
    }
    const mine = delta.get(rid)
    for (const e of entries) {
      if (e.resourceId !== rid) continue
      for (let i = 0; i < e.days.length; i++) {
        if (e.hours[i] <= 0) continue
        const before = day.get(rid)!.get(e.days[i]) ?? 0
        if (excessOf(rid, e.days[i], before) <= EPS) continue
        const after = excessOf(rid, e.days[i], before + (mine?.get(e.days[i]) ?? 0))
        if (after > excessOf(rid, e.days[i], before) - EPS) return null
        if (after <= EPS) cleared++
      }
    }
    return { newStart, newEnd, delta, planned, cleared }
  }

  outer: for (const { id: rid } of ranked) {
    for (const d of overList(rid)) {
      if (!isOver(rid, d)) continue // an earlier move cleared it
      // Tasks of this resource that cover day d, can move, and have float.
      const candidates: { key: string; task: TaskFact }[] = []
      const seen = new Set<string>()
      for (const e of entriesByResource.get(rid)!) {
        if (!e.follows) continue
        const key = taskKey(e.assignment.sheetId, e.assignment.rowId)
        if (seen.has(key) || moved.has(key)) continue
        const i = e.days.indexOf(d)
        if (i < 0 || e.hours[i] <= 0) continue
        const task = model.tasks.get(key)!
        if ((task.totalFloat ?? 0) <= 0 || task.durationDays <= 0) continue
        seen.add(key)
        candidates.push({ key, task })
      }
      candidates.sort((a, b) => (b.task.freeFloat ?? 0) - (a.task.freeFloat ?? 0) || (b.task.totalFloat ?? 0) - (a.task.totalFloat ?? 0) || a.key.localeCompare(b.key))

      let accepted: { key: string; task: TaskFact; k: number; res: NonNullable<ReturnType<typeof tryShift>> } | null = null
      // Pass 1 stays within free float (nothing downstream moves); pass 2 may use the rest of total float.
      for (const pass of [1, 2] as const) {
        for (const c of candidates) {
          const free = Math.min(c.task.freeFloat ?? 0, c.task.totalFloat ?? 0)
          const total = c.task.totalFloat ?? 0
          const kMin = pass === 1 ? 1 : free + 1
          const kMax = Math.min(pass === 1 ? free : total, maxShift)
          for (let k = kMin; k <= kMax; k++) {
            if (evaluations >= maxEvaluations) {
              truncated = true
              break outer
            }
            const res = tryShift(c.key, c.task, k, rid, d)
            if (res) {
              accepted = { key: c.key, task: c.task, k, res }
              break
            }
          }
          if (accepted) break
        }
        if (accepted) break
      }
      if (!accepted) continue

      // Apply the move to the working state.
      for (const [r, m] of accepted.res.delta) {
        const dm = day.get(r)!
        for (const [dd, dh] of m) {
          const v = (dm.get(dd) ?? 0) + dh
          if (v > EPS) dm.set(dd, v)
          else dm.delete(dd)
        }
      }
      for (const p of accepted.res.planned) {
        p.entry.days = p.days
        p.entry.hours = p.hours
      }
      moved.add(accepted.key)
      const free = Math.min(accepted.task.freeFloat ?? 0, accepted.task.totalFloat ?? 0)
      suggestions.push({
        sheetId: accepted.task.sheetId,
        rowId: accepted.task.rowId,
        taskName: accepted.task.name,
        shiftDays: accepted.k,
        newStart: accepted.res.newStart,
        newEnd: accepted.res.newEnd,
        resourceId: rid,
        clearedDays: accepted.res.cleared,
        knockOn: accepted.k > free,
      })
      if (suggestions.length >= maxSuggestions) {
        truncated = true
        break outer
      }
    }
  }

  const unresolved: { resourceId: string; overDays: number }[] = []
  for (const id of targets) {
    const n = overList(id).length
    if (n > 0) unresolved.push({ resourceId: id, overDays: n })
  }
  return { suggestions, unresolved, truncated }
}
