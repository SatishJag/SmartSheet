import { addWorkingDays, previousWorkingDay } from '../engine/calendar'
import type { Calendar } from '../engine/types'
import { suggestDuration, type DurationEvidence } from './durations'
import type { ProcurementType, PlanActivity, ProcActivity, ProcurementPlan } from './types'

/** An activity with the length to schedule it by; `included: false` takes it out of the plan. */
export type DurationedActivity = ProcActivity & { duration: number | null; included: boolean }

/** An activity's length in working days; elapsed-time steps convert at five working days per seven. */
export function workingLength(a: Pick<DurationedActivity, 'duration' | 'included' | 'elapsed'>): number {
  if (!a.included || a.duration === null || a.duration <= 0) return 0
  return a.elapsed ? Math.max(1, Math.ceil((a.duration * 5) / 7)) : a.duration
}

/** The activity that brings the goods to site: the type's own anchor, else the last receipt, else the last activity. */
export function anchorOf(type: ProcurementType): string {
  if (type.anchor) return type.anchor
  const receipts = type.activities.filter((a) => a.stage === 'Receipt')
  return (receipts.length > 0 ? receipts[receipts.length - 1] : type.activities[type.activities.length - 1]).code
}

/**
 * Dates for each activity, worked back from the need date: the anchor finishes on it and every
 * activity it depends on finishes in time for its successors (as late as the logic allows).
 * Work that does not feed the anchor (handover, site acceptance) runs forward from it.
 * Working-day arithmetic uses the sheet's calendar. Throws if the logic has a loop.
 */
export function backSchedule(acts: readonly DurationedActivity[], anchor: string, needDate: string, cal: Calendar) {
  const codes = new Set(acts.map((a) => a.code))
  if (!codes.has(anchor)) throw new Error(`Unknown anchor activity ${anchor}`)
  const preds = new Map(acts.map((a) => [a.code, a.predecessors.filter((c) => codes.has(c))]))
  const succs = new Map<string, string[]>(acts.map((a) => [a.code, []]))
  for (const [c, ps] of preds) for (const p of ps) succs.get(p)!.push(c)
  const position = new Map(acts.map((a, i) => [a.code, i]))

  // Topological order, the catalogue order breaking ties.
  const order: string[] = []
  const done = new Set<string>()
  const visit = (c: string, path: readonly string[]): void => {
    if (path.includes(c)) throw new Error(`The activity logic has a loop at ${c}`)
    if (done.has(c)) return
    for (const p of [...preds.get(c)!].sort((a, b) => position.get(a)! - position.get(b)!)) visit(p, [...path, c])
    done.add(c)
    order.push(c)
  }
  for (const a of acts) visit(a.code, [])

  const ancestors = new Set<string>()
  const stack = [anchor]
  while (stack.length > 0) {
    const c = stack.pop()!
    if (ancestors.has(c)) continue
    ancestors.add(c)
    stack.push(...preds.get(c)!)
  }

  const by = new Map(acts.map((a) => [a.code, a]))
  // Working-day indices relative to the need date, which is index 0.
  const start = new Map<string, number>()
  const finish = new Map<string, number>()
  for (const c of [...order].reverse()) {
    if (!ancestors.has(c)) continue
    const later = succs.get(c)!.filter((s) => ancestors.has(s)).map((s) => start.get(s)! - 1)
    const f = c === anchor ? 0 : later.length > 0 ? Math.min(...later) : 0
    finish.set(c, f)
    start.set(c, f - workingLength(by.get(c)!) + 1)
  }
  for (const c of order) {
    if (ancestors.has(c)) continue
    const ready = preds.get(c)!.filter((x) => finish.has(x)).map((x) => finish.get(x)! + 1)
    const s = ready.length > 0 ? Math.max(...ready) : 1
    start.set(c, s)
    finish.set(c, s + workingLength(by.get(c)!) - 1)
  }

  const needDay = previousWorkingDay(cal, needDate)
  const day = (i: number) => addWorkingDays(cal, needDay, i)
  const out: PlanActivity[] = acts.map((a) => {
    const s = start.get(a.code)!
    const f = finish.get(a.code)!
    return {
      ...a,
      basis: 'template',
      samples: 0,
      start: day(s),
      // A step left out or of zero length takes no time: it finishes as it starts.
      finish: day(Math.max(f, s)),
      anchor: a.code === anchor,
      afterNeed: !ancestors.has(a.code),
    }
  })
  const included = out.filter((a) => a.included)
  if (included.length === 0) throw new Error('The plan has no activities')
  const startBy = included.reduce((m, a) => (a.start < m ? a.start : m), included[0].start)
  const finishOn = included.reduce((m, a) => (a.finish > m ? a.finish : m), included[0].finish)
  const award = included.find((a) => a.award)
  return { activities: out, startBy, awardBy: award ? award.finish : startBy, finishOn }
}

export interface DraftOptions {
  /** Past durations to suggest from. */
  evidence?: DurationEvidence
  /** Durations to use instead of the suggestion, by activity code (working days). */
  durations?: Record<string, number>
  /** Optional activities to leave out, by activity code. */
  exclude?: readonly string[]
}

/**
 * A pre-award plan for one equipment type: each activity gets a duration from the best evidence
 * available (or the one given), then the plan is worked back from the date site needs it.
 */
export function draftPlan(type: ProcurementType, requiredOnSite: string, cal: Calendar, opts: DraftOptions = {}): ProcurementPlan {
  const exclude = new Set(opts.exclude ?? [])
  const known = new Set(type.activities.map((a) => a.code))
  for (const c of [...exclude, ...Object.keys(opts.durations ?? {})]) {
    if (!known.has(c)) throw new Error(`${type.name} has no activity ${c}`)
  }
  const meta = new Map<string, Pick<PlanActivity, 'basis' | 'samples'>>()
  const acts: DurationedActivity[] = type.activities.map((a) => {
    const given = opts.durations?.[a.code]
    const s = given !== undefined ? { days: given, basis: 'edited' as const, samples: 0 } : suggestDuration(a, opts.evidence)
    meta.set(a.code, { basis: s.basis, samples: s.samples })
    return { ...a, duration: s.days, included: !exclude.has(a.code) }
  })
  const scheduled = backSchedule(acts, anchorOf(type), requiredOnSite, cal)
  const activities = scheduled.activities.map((a) => ({ ...a, ...meta.get(a.code)! }))
  return {
    type,
    requiredOnSite,
    startBy: scheduled.startBy,
    awardBy: scheduled.awardBy,
    finishOn: scheduled.finishOn,
    activities,
    missing: activities.filter((a) => a.included && a.duration === null).map((a) => a.code),
  }
}
