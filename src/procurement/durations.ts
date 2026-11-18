import { stageWindow } from './equipment'
import type { DurationBasis, ProcActivity } from './types'

/**
 * Past durations (working days) to suggest from. All optional: with none, every duration falls
 * back to the template window, and a duration is "needed" only for an activity with no window.
 */
export interface DurationEvidence {
  /** Actual durations of the same activity on completed work, by activity code. */
  history?: Record<string, number[]>
  /** Durations given to the same activity in earlier approved plans, by activity code. */
  plans?: Record<string, number[]>
  /** Actual durations of the same stage on other equipment, by stage. */
  similar?: Record<string, number[]>
}

export interface SuggestedDuration {
  days: number | null
  basis: DurationBasis
  samples: number
}

/** The median, rounded half to even (so 2.5 gives 2 and 3.5 gives 4) like the Procurement app. */
export function medianDays(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const m = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  const floor = Math.floor(m)
  const diff = m - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

const nonEmpty = (xs: readonly number[] | undefined): xs is readonly number[] => !!xs && xs.length > 0

/** A duration for one activity: history, then earlier plans, then similar work, then the template window. */
export function suggestDuration(activity: ProcActivity, evidence: DurationEvidence = {}): SuggestedDuration {
  const exact = evidence.history?.[activity.code]
  if (nonEmpty(exact)) return { days: medianDays(exact), basis: 'history', samples: exact.length }
  const earlier = evidence.plans?.[activity.code]
  if (nonEmpty(earlier)) return { days: medianDays(earlier), basis: 'plans', samples: earlier.length }
  const similar = evidence.similar?.[activity.stage]
  if (nonEmpty(similar)) return { days: medianDays(similar), basis: 'similar', samples: similar.length }
  const window = stageWindow(activity.stage)
  if (window) return { days: window[1], basis: 'template', samples: 0 }
  return { days: null, basis: 'needed', samples: 0 }
}
