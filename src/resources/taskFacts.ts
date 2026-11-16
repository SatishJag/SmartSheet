import { analyzeCriticalPath } from '../engine/criticalPath'
import { schedule, type ScheduleResult } from '../engine/schedule'
import type { SheetData } from '../store/persistence'
import { toSchedInput } from '../store/scheduleInput'
import type { TaskFact } from './engine'

/**
 * The schedulable tasks of a sheet as the resource engine needs them: dates and duration on the sheet
 * calendar, float and criticality (only when dependencies are on). Summary rows (rows with children)
 * are left out: work is assigned to the tasks beneath them. Pure. Pass the store's live `scheduled`
 * to avoid scheduling twice.
 */
export function taskFactsFromSheet(data: SheetData, scheduled?: ScheduleResult): TaskFact[] {
  const input = toSchedInput(data)
  if (!input) return []
  const result = scheduled ?? schedule(input.rows, input.deps, input.calendar)
  const hasChildren = new Set(input.rows.flatMap((r) => (r.parentId !== null ? [r.parentId] : [])))
  const critical = data.sheet.dependenciesEnabled ? analyzeCriticalPath(input.rows, input.deps, input.calendar, result) : null
  const nameCol = data.columns[0]?.id
  const cells = new Map(data.rows.map((r) => [r.id, r.cells]))
  const out: TaskFact[] = []
  for (const row of input.rows) {
    const s = result.byRow[row.id]
    if (!s || hasChildren.has(row.id)) continue
    const raw = nameCol ? cells.get(row.id)?.[nameCol] : undefined
    const info = critical?.byRow[row.id]
    out.push({
      sheetId: data.sheet.id,
      rowId: row.id,
      name: typeof raw === 'string' && raw.trim() ? raw.trim() : typeof raw === 'number' ? String(raw) : '(untitled)',
      start: s.start,
      end: s.end,
      durationDays: s.durationDays,
      elapsed: row.elapsed,
      calendar: input.calendar,
      totalFloat: info ? info.totalFloat : null,
      freeFloat: info ? info.freeFloat : null,
      critical: info ? info.critical : false,
    })
  }
  return out
}
