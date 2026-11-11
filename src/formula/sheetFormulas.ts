import { fullOrder } from '../model/hierarchy'
import type { Column, ColumnRole } from '../model/validate'
import type { SheetData } from '../store/persistence'
import { evaluate, type FormulaContext, type FormulaValue } from './evaluate'

/**
 * Formula cells of a sheet, evaluated for display. A cell whose stored value is a string
 * starting with `=` in a non-schedule column is a formula; the stored text is what the editor
 * shows, the evaluated value is what the grid shows (and sorts and filters by).
 */

export const ERROR_DISPLAY = '#ERROR'
export const CIRCULAR_DISPLAY = '#CIRCULAR'
const CIRCULAR_MESSAGE = 'Circular reference: the formula depends on its own value'

export type FormulaCellResult =
  | { ok: true; value: FormulaValue }
  | { ok: false; error: string; display: typeof ERROR_DISPLAY | typeof CIRCULAR_DISPLAY }

/** Scheduling columns keep their stored text: their values come from the scheduler. */
const SCHEDULE_ROLES: readonly ColumnRole[] = ['start', 'end', 'duration', 'predecessor', 'percentComplete']

export const isFormula = (value: unknown): value is string => typeof value === 'string' && value.startsWith('=')

/** Whether formulas in this column are evaluated. */
export const evaluatesFormulas = (col: Column) => !col.role || !SCHEDULE_ROLES.includes(col.role)

/** A formula value as shown in a cell: numbers plainly, booleans TRUE/FALSE, strings as they are. */
export function formatFormulaValue(value: FormulaValue): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') return String(Number(value.toPrecision(12)))
  return value
}

/** The text a formula cell shows: its formatted value, or #ERROR / #CIRCULAR. */
export const formulaDisplay = (r: FormulaCellResult) => (r.ok ? formatFormulaValue(r.value) : r.display)

export type FormulaEvaluator = (rowId: string, colId: string) => FormulaCellResult | null

const cache = new WeakMap<SheetData, FormulaEvaluator>()

/**
 * The evaluator for one SheetData, memoized per object identity (every edit makes a new one).
 * Returns null for a cell that is not an evaluated formula. Results are cached per cell; column
 * lookups and per-column value arrays are built once, so a visible formula cell costs at most
 * O(rows) (a SUM over a column). References to other formula cells use their evaluated values;
 * a reference back to a cell being evaluated is a circular reference.
 */
export function formulaEvaluator(data: SheetData): FormulaEvaluator {
  let ev = cache.get(data)
  if (!ev) {
    ev = buildEvaluator(data)
    cache.set(data, ev)
  }
  return ev
}

class CellReferenceError extends Error {}

function buildEvaluator(data: SheetData): FormulaEvaluator {
  const byId = new Map(data.rows.map((r) => [r.id, r]))
  let order: string[] | null = null
  let indexOf: Map<string, number> | null = null
  const rowOrder = () => (order ??= fullOrder(data.rows))
  const rowIndex = (id: string) => (indexOf ??= new Map(rowOrder().map((rid, i) => [rid, i]))).get(id)

  const colById = new Map(data.columns.map((c) => [c.id, c]))
  const colByTitle = new Map<string, Column>()
  for (const c of data.columns) if (!colByTitle.has(c.title)) colByTitle.set(c.title, c)

  // Raw stored values of a column in full tree order, built on first use.
  const rawColumns = new Map<string, unknown[]>()
  const rawColumn = (colId: string) => {
    let values = rawColumns.get(colId)
    if (!values) {
      values = rowOrder().map((id) => byId.get(id)!.cells[colId])
      rawColumns.set(colId, values)
    }
    return values
  }

  const results = new Map<string, FormulaCellResult>()
  const inProgress = new Set<string>()

  function evalCell(rowId: string, col: Column, formula: string): FormulaCellResult {
    const key = `${rowId}\u0000${col.id}`
    const cached = results.get(key)
    if (cached) return cached
    if (inProgress.has(key)) throw new CellReferenceError(CIRCULAR_MESSAGE)
    inProgress.add(key)
    const ctx: FormulaContext = {
      rowIndex: rowIndex(rowId) ?? 0,
      rowCount: rowOrder().length,
      hasColumn: (title) => colByTitle.has(title),
      cell(title, idx) {
        const c = colByTitle.get(title)!
        const raw = rawColumn(c.id)[idx]
        if (!isFormula(raw) || !evaluatesFormulas(c)) return raw
        const r = evalCell(rowOrder()[idx], c, raw)
        if (!r.ok) throw new CellReferenceError(r.error) // a referenced error propagates
        return r.value
      },
    }
    const r = evaluate(formula, ctx)
    inProgress.delete(key)
    const result: FormulaCellResult = r.ok
      ? r
      : { ok: false, error: r.error, display: r.error === CIRCULAR_MESSAGE ? CIRCULAR_DISPLAY : ERROR_DISPLAY }
    results.set(key, result)
    return result
  }

  return (rowId, colId) => {
    const col = colById.get(colId)
    const raw = byId.get(rowId)?.cells[colId]
    if (!col || !isFormula(raw) || !evaluatesFormulas(col)) return null
    return evalCell(rowId, col, raw)
  }
}
