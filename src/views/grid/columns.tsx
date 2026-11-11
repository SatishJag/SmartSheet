import { columnResizingFeature, columnSizingFeature, tableFeatures, type ColumnDef } from '@tanstack/react-table'
import type { Scheduled } from '../../engine/schedule'
import type { RowRecord } from '../../store/persistence'
import type { Column, ColumnRole } from '../../model/validate'
import { formulaDisplay, type FormulaCellResult } from '../../formula/sheetFormulas'

export const gridFeatures = tableFeatures({ columnSizingFeature, columnResizingFeature })
export type GridFeatures = typeof gridFeatures

/** One sheet row as the grid sees it. */
export interface GridRow {
  id: string
  /** 1-based number in tree order. */
  rowNumber: number
  isParent: boolean
  record: RowRecord
  scheduled: Scheduled | undefined
  /** Scheduler messages for this row, joined; null when there are none. */
  scheduleError: string | null
  /** Predecessor text derived from the sheet's dependencies (never stored in cells). */
  predecessors: string
  /** The evaluated formula in a cell of this row; null when the cell holds no evaluated formula. */
  formulaOf?: (colId: string) => FormulaCellResult | null
}

export const ROW_NUMBER_COLUMN_ID = '__row'
export const DEFAULT_COLUMN_WIDTH = 150
export const MIN_COLUMN_WIDTH = 60

/** TanStack column defs: the row-number column, then one per sheet column. */
export function buildColumnDefs(columns: Column[]): ColumnDef<GridFeatures, GridRow>[] {
  return [
    { id: ROW_NUMBER_COLUMN_ID, header: '', size: 56, minSize: 40, enableResizing: false },
    ...columns.map(
      (c): ColumnDef<GridFeatures, GridRow> => ({
        id: c.id,
        header: c.title,
        size: DEFAULT_COLUMN_WIDTH,
        minSize: MIN_COLUMN_WIDTH,
      }),
    ),
  ]
}

/** Roles whose value on a parent row is rolled up from its children. */
const PARENT_ROLLUP_ROLES: readonly ColumnRole[] = ['start', 'duration', 'percentComplete']

/** Whether a cell can be edited: never an 'end' cell, never a rolled-up cell on a parent row. */
export function isEditable(col: Column, row: GridRow): boolean {
  if (col.role === 'end') return false
  if (row.isParent && col.role && PARENT_ROLLUP_ROLES.includes(col.role)) return false
  return true
}

/** A stored cell value as the string the editor starts from (and setCell accepts). */
export function toEditString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

/** The string a cell's editor opens with: the derived text for the predecessor column. */
export function editString(col: Column, row: GridRow): string {
  return col.role === 'predecessor' ? row.predecessors : toEditString(row.record.cells[col.id])
}

const formatPercent = (n: number) => `${Math.round(n * 10) / 10}%`

/**
 * The text shown for a non-checkbox cell. Scheduled start/end replace stored dates when the
 * scheduler produced a result for the row; parent rows show rolled-up duration and % complete.
 */
export function displayText(col: Column, row: GridRow): string {
  if (col.role === 'predecessor') return row.predecessors
  const sched = row.scheduled
  if (sched) {
    if (col.role === 'start') return sched.start
    if (col.role === 'end') return sched.end
    if (row.isParent && col.role === 'duration') return `${sched.durationDays}d`
    if (row.isParent && col.role === 'percentComplete') return formatPercent(sched.percentComplete)
  }
  const formula = row.formulaOf?.(col.id)
  if (formula) return formulaDisplay(formula)
  const value = row.record.cells[col.id]
  if (col.role === 'percentComplete' && typeof value === 'number') return formatPercent(value)
  return toEditString(value)
}

/** The error message of a cell's formula, or undefined when it has none. */
export function formulaError(col: Column, row: GridRow): string | undefined {
  const formula = row.formulaOf?.(col.id)
  return formula && !formula.ok ? formula.error : undefined
}
