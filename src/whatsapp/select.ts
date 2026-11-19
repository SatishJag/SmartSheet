/**
 * The task lists behind the WhatsApp menu (the WBS9 bot's options 1-5 and 8), over sheet facts.
 * Pure. Every list excludes summary rows and, unless stated, completed work.
 */
import type { TaskFact } from './tasks'

const open = (ts: TaskFact[]) => ts.filter((t) => !t.complete)
const byFinish = (a: TaskFact, b: TaskFact) => (a.finish ?? '9999').localeCompare(b.finish ?? '9999') || a.number - b.number

/** Past their finish date and not complete; the longest delay first. */
export function delayed(work: TaskFact[]): TaskFact[] {
  return open(work)
    .filter((t) => t.delayDays > 0)
    .sort((a, b) => b.delayDays - a.delayDays || a.number - b.number)
}

/** Finishing today or within `days` days, not complete; soonest first. */
export function dueWithin(work: TaskFact[], days = 30): TaskFact[] {
  return open(work)
    .filter((t) => t.daysToFinish !== null && t.daysToFinish >= 0 && t.daysToFinish <= days)
    .sort(byFinish)
}

/** Due within 30 days and either on the critical path or forecast to finish late. */
export function atRisk(work: TaskFact[]): TaskFact[] {
  return dueWithin(work, 30).filter((t) => t.critical || (t.forecastFinish !== null && t.finish !== null && t.forecastFinish > t.finish))
}

/** Open, not late and not at risk. */
export function onTrack(work: TaskFact[]): TaskFact[] {
  const risky = new Set(atRisk(work).map((t) => t.rowId))
  return open(work)
    .filter((t) => t.delayDays === 0 && !risky.has(t.rowId))
    .sort(byFinish)
}

/** Open work on the critical path: late ones first, then by finish. */
export function criticalOpen(work: TaskFact[]): TaskFact[] {
  return open(work)
    .filter((t) => t.critical)
    .sort((a, b) => b.delayDays - a.delayDays || byFinish(a, b))
}

/** Open milestones, overdue ones first, then by date. */
export function milestones(work: TaskFact[]): TaskFact[] {
  return open(work)
    .filter((t) => t.milestone)
    .sort((a, b) => b.delayDays - a.delayDays || byFinish(a, b))
}

/** Open work whose task-owner column holds `email`; late first, then by finish. */
export function ownedBy(work: TaskFact[], email: string): TaskFact[] {
  const e = email.toLowerCase()
  return open(work)
    .filter((t) => t.owners.includes(e))
    .sort((a, b) => b.delayDays - a.delayDays || byFinish(a, b))
}

export interface MenuCounts {
  total: number
  complete: number
  delayed: number
  due30: number
  onTrack: number
  atRisk: number
  critical: number
  criticalDelayed: number
  milestones: number
}

export function menuCounts(work: TaskFact[]): MenuCounts {
  const crit = criticalOpen(work)
  return {
    total: work.length,
    complete: work.filter((t) => t.complete).length,
    delayed: delayed(work).length,
    due30: dueWithin(work, 30).length,
    onTrack: onTrack(work).length,
    atRisk: atRisk(work).length,
    critical: crit.length,
    criticalDelayed: crit.filter((t) => t.delayDays > 0).length,
    milestones: milestones(work).length,
  }
}

/** Delayed work grouped by owner e-mail (work without an owner is left out). */
export function delayedByOwner(work: TaskFact[]): Map<string, TaskFact[]> {
  const out = new Map<string, TaskFact[]>()
  for (const t of delayed(work)) for (const o of t.owners) out.set(o, [...(out.get(o) ?? []), t])
  return out
}
