import { parseDuration } from '../engine/duration'
import type { SchedDep, SchedRow } from '../engine/schedule'
import type { Calendar } from '../engine/types'
import { fullOrder } from '../model/hierarchy'
import type { SheetData } from './persistence'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Builds the scheduling engine input from sheet data. Pure.
 * Returns null (no scheduling) when the sheet has no start-role column.
 * Columns are found by role, never by title. Rows are given in depth-first sheet order.
 */
export function toSchedInput(data: SheetData): { rows: SchedRow[]; deps: SchedDep[]; calendar: Calendar } | null {
  const roleCol = (role: string) => data.columns.find((c) => c.role === role)?.id
  const startCol = roleCol('start')
  if (startCol === undefined) return null
  const durationCol = roleCol('duration')
  const percentCol = roleCol('percentComplete')

  const calendar = data.sheet.calendar
  const oneDay = calendar.hoursPerDay * 60
  const byId = new Map(data.rows.map((r) => [r.id, r]))

  const rows: SchedRow[] = fullOrder(data.rows).map((id) => {
    const r = byId.get(id)!
    const start = r.cells[startCol]
    const rawDuration = durationCol === undefined ? null : r.cells[durationCol]
    const duration = typeof rawDuration === 'string' ? parseDuration(rawDuration, calendar.hoursPerDay) : null
    const pct = percentCol === undefined ? undefined : r.cells[percentCol]
    return {
      id: r.id,
      parentId: r.parentId,
      durationMinutes: duration ? duration.minutes : oneDay,
      elapsed: duration ? duration.elapsed : false,
      manualStart: typeof start === 'string' && ISO_DATE.test(start) ? start : null,
      percentComplete: typeof pct === 'number' && Number.isFinite(pct) ? pct : 0,
    }
  })

  return { rows, deps: data.sheet.dependenciesEnabled ? data.dependencies : [], calendar }
}
