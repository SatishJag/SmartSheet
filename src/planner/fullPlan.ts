/**
 * "All (full project plan)" in the wizard (docs/superpowers/specs/2026-11-22-full-plan-design.md): the
 * master schedule of each project type, listed first under one label. The Data centre master plans one
 * whole project with no items and no AI, on a 7-day week. Pure.
 */
import type { Calendar } from '../engine/types'
import { SEVEN_DAY_WEEK } from './dcMasterDraft'
import type { ScheduleType } from './types'

export const ALL_LABEL = 'All (full project plan)'

/** The master schedules shown as All: Data centre's, then Properties'. */
export const FULL_PLAN_TYPES: readonly string[] = ['dc-master', 'property-development']

/** Full plans of one whole project: no items to choose, no notes, no AI. */
export const NO_ITEM_TYPES: readonly string[] = ['dc-master']

/** The schedule types with the full-plan ones first, renamed All; the others unchanged, in order. */
export function withFullPlanFirst(types: ScheduleType[]): ScheduleType[] {
  const full = types.filter((t) => FULL_PLAN_TYPES.includes(t.id)).map((t) => ({ ...t, name: ALL_LABEL }))
  return [...full, ...types.filter((t) => !FULL_PLAN_TYPES.includes(t.id))]
}

/** The calendar a plan of this schedule type uses: a 7-day week for the Data centre master. */
export function planCalendar(scheduleType: string, base: Calendar): Calendar {
  return scheduleType === 'dc-master' ? { ...base, workingWeekdays: [...SEVEN_DAY_WEEK] } : base
}
