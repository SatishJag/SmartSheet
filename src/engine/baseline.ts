import { workingDaysBetween } from './calendar'
import type { ScheduleResult } from './schedule'
import type { Calendar } from './types'

/** One row's frozen dates in a baseline. */
export interface BaselineRow {
  rowId: string
  start: string
  end: string
  /** Working days (0 for a milestone). */
  durationDays: number
}

/** A saved snapshot of a sheet's schedule (slots 1-5 per sheet). */
export interface Baseline {
  id: string
  slot: number
  name: string
  createdAt: string
  rows: BaselineRow[]
}

/** A baseline without its rows (what loads with the sheet). */
export type BaselineMeta = Omit<Baseline, 'rows'>

export type VarianceStatus = 'on-track' | 'late' | 'ahead' | 'new'

/** Working days the live schedule is later (+) or earlier (-) than the baseline; null for a new row. */
export interface RowVariance {
  startVariance: number | null
  finishVariance: number | null
  durationVariance: number | null
  status: VarianceStatus
}

export interface BaselineComparison {
  byRow: Record<string, RowVariance>
  /** Rows in the baseline that no longer exist or can no longer be scheduled. */
  removedRowIds: string[]
  /** Latest finish now versus then, in working days; null when either side has no scheduled rows. */
  projectFinishVariance: number | null
}

/** What to store when the planner saves a baseline: every scheduled row, summary rows included. */
export function snapshotSchedule(result: ScheduleResult): BaselineRow[] {
  return Object.entries(result.byRow).map(([rowId, s]) => ({ rowId, start: s.start, end: s.end, durationDays: s.durationDays }))
}

function latestEnd(rows: { end: string }[]): string | null {
  return rows.reduce<string | null>((m, r) => (m === null || r.end > m ? r.end : m), null)
}

/** Compares the live schedule with a baseline, row by row and for the project finish. Pure. */
export function compareToBaseline(cal: Calendar, current: ScheduleResult, baseline: Baseline): BaselineComparison {
  const then = new Map(baseline.rows.map((r) => [r.rowId, r]))
  const byRow: Record<string, RowVariance> = {}
  for (const [rowId, now] of Object.entries(current.byRow)) {
    const base = then.get(rowId)
    if (!base) {
      byRow[rowId] = { startVariance: null, finishVariance: null, durationVariance: null, status: 'new' }
      continue
    }
    const finishVariance = workingDaysBetween(cal, base.end, now.end)
    byRow[rowId] = {
      startVariance: workingDaysBetween(cal, base.start, now.start),
      finishVariance,
      durationVariance: now.durationDays - base.durationDays,
      status: finishVariance > 0 ? 'late' : finishVariance < 0 ? 'ahead' : 'on-track',
    }
  }
  const removedRowIds = baseline.rows.filter((r) => !(r.rowId in current.byRow)).map((r) => r.rowId)
  const baseEnd = latestEnd(baseline.rows)
  const nowEnd = latestEnd(Object.values(current.byRow))
  return {
    byRow,
    removedRowIds,
    projectFinishVariance: baseEnd !== null && nowEnd !== null ? workingDaysBetween(cal, baseEnd, nowEnd) : null,
  }
}
