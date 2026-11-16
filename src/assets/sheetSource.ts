import type { ScheduleResult } from '../engine/schedule'
import type { SheetData } from '../store/persistence'
import { editString, isEditable, readOnlyReason } from '../views/grid/columns'
import { buildGridRows } from '../views/grid/viewModel'
import type { SourceSheet } from './types'
import { isBlank } from './values'

/**
 * Adapts a loaded sheet (its store state) to the plain `SourceSheet` the report and widget engines read.
 * This is the ONE place that knows how the grid derives what a cell shows (scheduled dates, roll-ups, the
 * predecessor text, formula results), by reusing the grid's own view model, so a report always agrees
 * with the sheet it came from.
 */

const cache = new WeakMap<SheetData, { scheduled: ScheduleResult; sheet: SourceSheet }>()

export function toSourceSheet(data: SheetData, scheduled: ScheduleResult): SourceSheet {
  const hit = cache.get(data)
  if (hit && hit.scheduled === scheduled) return hit.sheet

  const gridRows = buildGridRows(data, scheduled)
  const byId = new Map(gridRows.map((r) => [r.id, r]))
  const cols = new Map(data.columns.map((c) => [c.id, c]))

  const sheet: SourceSheet = {
    id: data.sheet.id,
    name: data.sheet.name,
    columns: data.columns.map((c) => ({ id: c.id, title: c.title, type: c.type, options: c.options })),
    rowIds: gridRows.map((r) => r.id),

    value(rowId, colId) {
      const row = byId.get(rowId)
      const col = cols.get(colId)
      if (!row || !col) return null
      if (col.role === 'predecessor') return row.predecessors
      const s = row.scheduled
      if (s) {
        if (col.role === 'start') return s.start
        if (col.role === 'end') return s.end
        if (row.isParent && col.role === 'duration') return `${s.durationDays}d`
        if (row.isParent && col.role === 'percentComplete') return Math.round(s.percentComplete * 10) / 10
      }
      const formula = row.formulaOf?.(colId)
      if (formula) return formula.ok ? formula.value : formula.display
      return row.record.cells[colId] ?? null
    },

    isBlankRow(rowId) {
      const row = byId.get(rowId)
      return !row || Object.values(row.record.cells).every((v) => isBlank(v))
    },

    readOnlyReason(rowId, colId) {
      const row = byId.get(rowId)
      const col = cols.get(colId)
      if (!row || !col) return 'This cell no longer exists'
      if (isEditable(col, row)) return null
      return readOnlyReason(col, row) ?? (col.role === 'end' ? 'End dates are set by the schedule' : 'This cell is calculated from other rows')
    },

    rawText(rowId, colId) {
      const row = byId.get(rowId)
      const col = cols.get(colId)
      return row && col ? editString(col, row) : ''
    },
  }
  cache.set(data, { scheduled, sheet })
  return sheet
}
