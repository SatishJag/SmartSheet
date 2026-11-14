import { addWorkingDays, isWorkingDay, nextWorkingDay, previousWorkingDay, shiftIso } from '../engine/calendar'
import { analyzeCriticalPath, depKey } from '../engine/criticalPath'
import { schedule, type SchedDep, type SchedRow, type Scheduled } from '../engine/schedule'
import type { Calendar } from '../engine/types'
import { isAcceptedDate } from '../model/validate'
import type { DraftActivity, DraftLink, PlanDraft } from './types'

/** One draft activity with the dates the engine gave it. */
export interface PlannedActivity extends DraftActivity {
  start: string
  end: string
  /** Working days the activity can slip before the plan's last finish moves. */
  totalFloat: number
  freeFloat: number
  critical: boolean
  isTarget: boolean
  /** True when the activity has no predecessors, so its start is entered by hand in the sheet. */
  isRoot: boolean
}

export interface Feasibility {
  /** True when the plan can still start on time (mustStartBy is today or later). */
  feasible: boolean
  /** Working days the plan is already behind (0 when feasible). */
  lateByWorkingDays: number
  /** Working days between the first possible start (today, or the next working day) and mustStartBy. */
  spareWorkingDays: number
  /** When late: the earliest the target can finish if work starts on the first possible day. */
  earliestTargetFinish: string | null
  /** Plain-language verdict for the planner. */
  message: string
}

export interface BackwardPlan {
  /** In draft order. */
  activities: PlannedActivity[]
  targetCode: string
  /** As requested (may be a non-working day). */
  requiredDate: string
  /** The working day the target finishes on: requiredDate, or the working day before it. */
  targetFinish: string
  /** Set when requiredDate is not a working day and the target finishes on the day before. */
  dateNote: string | null
  /** The earliest start of any activity: the day work must begin. */
  mustStartBy: string
  /** The latest finish of any activity (after the target when activities follow it). */
  projectEnd: string
  /** depKey(fromCode, toCode) of every link that joins two critical activities and drives the successor. */
  criticalLinks: string[]
  /** The links the dates were computed from: the draft's, at most one per pair. */
  links: DraftLink[]
  feasibility: Feasibility
  /** Engine runs it took to land the target exactly on targetFinish (a translation: normally 2). */
  iterations: number
}

/** Engine runs before giving up; the shift is a pure translation, so 2 runs suffice in practice. */
const MAX_ITERATIONS = 10

/** Today's date in the browser's time zone, as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Signed number of working days from `from` to `to`: the working days in (from, to] when to is
 * later, minus those in (to, from] when it is earlier. For two working days, the difference of
 * their positions in the working calendar.
 */
export function workingDaysFrom(cal: Calendar, from: string, to: string): number {
  if (from === to) return 0
  const forward = to > from
  let count = 0
  for (let day = from; day !== to; ) {
    day = shiftIso(day, forward ? 1 : -1)
    if (isWorkingDay(cal, day)) count++
  }
  return forward ? count : -count
}

/**
 * The draft's links, keeping the first link of each predecessor/successor pair (a sheet stores at
 * most one dependency per pair, so the preview must schedule from the same set the sheet will).
 */
export function uniqueLinks(links: DraftLink[]): DraftLink[] {
  const seen = new Set<string>()
  return links.filter((l) => {
    const key = depKey(l.from, l.to)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Minutes for a number of working days on this calendar (how the sheet stores durations and lags). */
export const daysToMinutes = (days: number, cal: Calendar) => Math.round(days * cal.hoursPerDay * 60)

/** Throws a readable error for a draft the engine cannot plan. */
function checkDraft(draft: PlanDraft): void {
  if (draft.activities.length === 0) throw new Error('The draft has no activities')
  const codes = new Set<string>()
  for (const a of draft.activities) {
    if (codes.has(a.code)) throw new Error(`The draft lists activity ${a.code} twice`)
    if (!Number.isFinite(a.durationDays) || a.durationDays < 0) {
      throw new Error(`Activity ${a.code} has an invalid duration`)
    }
    codes.add(a.code)
  }
  if (!codes.has(draft.targetCode)) throw new Error(`The draft's target activity ${draft.targetCode} is not in the plan`)
  for (const l of draft.links) {
    if (!codes.has(l.from) || !codes.has(l.to)) throw new Error(`A link refers to an unknown activity (${l.from} -> ${l.to})`)
    if (l.from === l.to) throw new Error(`Activity ${l.from} cannot depend on itself`)
    if (!Number.isFinite(l.lagDays)) throw new Error(`The link ${l.from} -> ${l.to} has an invalid lag`)
  }
  if (!isAcceptedDate(draft.request.requiredDate)) {
    throw new Error(`The required date "${draft.request.requiredDate}" is not a valid date`)
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Backward planning: dates for every activity of the draft such that the target activity finishes
 * exactly on the required date (or the working day before it, when that is not a working day).
 *
 * Uses the forward scheduler unchanged: every activity without predecessors gets the same manual
 * start S. The forward pass works purely in working-day steps (durations, lags, leads, and the
 * FS/SS/FF/SF rules all count working days from a working-day start), so moving S by k working days
 * moves every date, the target's finish included, by exactly k working days. Starting from a
 * provisional S, one run measures the gap between the target's finish and the date wanted, S moves
 * by that gap, and the next run lands on it. The loop re-checks until the gap is zero, so a
 * calendar edge case could only cost another run, never a wrong date.
 *
 * Feasibility compares mustStartBy (the earliest start of any activity) with today.
 */
export function planBackward(draft: PlanDraft, cal: Calendar, today: string): BackwardPlan {
  checkDraft(draft)
  const requiredDate = draft.request.requiredDate
  const targetFinish = previousWorkingDay(cal, requiredDate)
  const dateNote =
    targetFinish === requiredDate
      ? null
      : `${requiredDate} is not a working day, so the plan finishes on the working day before, ${targetFinish}.`

  const links = uniqueLinks(draft.links)
  const hasPredecessor = new Set(links.map((l) => l.to))
  const deps: SchedDep[] = links.map((l) => ({
    predecessorId: l.from,
    successorId: l.to,
    type: l.type,
    lagMinutes: daysToMinutes(l.lagDays, cal),
  }))
  const rowsFor = (start: string): SchedRow[] =>
    draft.activities.map((a) => ({
      id: a.code,
      parentId: null,
      durationMinutes: daysToMinutes(a.durationDays, cal),
      elapsed: false,
      manualStart: hasPredecessor.has(a.code) ? null : start,
      percentComplete: 0,
    }))

  let start = targetFinish
  let iterations = 0
  let rows: SchedRow[]
  let result: ReturnType<typeof schedule>
  for (;;) {
    rows = rowsFor(start)
    result = schedule(rows, deps, cal)
    iterations++
    if (result.errors.length > 0) {
      throw new Error(`The draft cannot be scheduled: ${result.errors[0].message}`)
    }
    const gap = workingDaysFrom(cal, result.byRow[draft.targetCode].end, targetFinish)
    if (gap === 0) break
    if (iterations >= MAX_ITERATIONS) throw new Error('Could not place the target activity on the required date')
    start = addWorkingDays(cal, start, gap)
  }

  const critical = analyzeCriticalPath(rows, deps, cal, result)
  const byRow: Record<string, Scheduled> = result.byRow
  const activities: PlannedActivity[] = draft.activities.map((a) => {
    const s = byRow[a.code]
    const c = critical.byRow[a.code]
    return {
      ...a,
      start: s.start,
      end: s.end,
      totalFloat: c?.totalFloat ?? 0,
      freeFloat: c?.freeFloat ?? 0,
      critical: c?.critical ?? false,
      isTarget: a.code === draft.targetCode,
      isRoot: !hasPredecessor.has(a.code),
    }
  })

  let mustStartBy = activities[0].start
  let projectEnd = activities[0].end
  for (const a of activities) {
    if (a.start < mustStartBy) mustStartBy = a.start
    if (a.end > projectEnd) projectEnd = a.end
  }

  return {
    activities,
    targetCode: draft.targetCode,
    requiredDate,
    targetFinish,
    dateNote,
    mustStartBy,
    projectEnd,
    criticalLinks: critical.criticalDeps,
    links,
    feasibility: assessFeasibility(cal, today, mustStartBy, targetFinish),
    iterations,
  }
}

/** Compares the day work must start with the first day it can start (today, or the next working day). */
export function assessFeasibility(cal: Calendar, today: string, mustStartBy: string, targetFinish: string): Feasibility {
  const firstPossible = nextWorkingDay(cal, today)
  const diff = workingDaysFrom(cal, mustStartBy, firstPossible)
  if (diff > 0) {
    const earliestTargetFinish = addWorkingDays(cal, targetFinish, diff)
    return {
      feasible: false,
      lateByWorkingDays: diff,
      spareWorkingDays: 0,
      earliestTargetFinish,
      message:
        `This plan should have started ${plural(diff, 'working day')} ago; the on-site date is at risk. ` +
        `Starting now, the earliest finish is ${earliestTargetFinish}.`,
    }
  }
  const spare = workingDaysFrom(cal, firstPossible, mustStartBy)
  const message =
    spare === 0
      ? `Work must start ${firstPossible === today ? 'today' : `on ${firstPossible}`} to meet the on-site date; there is no spare time.`
      : `Work must start by ${mustStartBy}: ${plural(spare, 'working day')} from now.`
  return { feasible: true, lateByWorkingDays: 0, spareWorkingDays: spare, earliestTargetFinish: null, message }
}
