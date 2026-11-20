import { fullOrder } from '../model/hierarchy'
import type { Column, ColumnRole } from '../model/validate'
import type { RowRecord, SheetData } from '../store/persistence'
import { evaluate, type CellKind, type Dest, type ErrorName, type FormulaContext, type FormulaValue } from './evaluate'
import { parseFormula, type Node } from './parse'
import { FormulaError } from './values'

/**
 * Formula cells of a sheet, evaluated for display.
 *
 * A formula is either typed into a cell (a stored string starting with `=`) or set on its COLUMN
 * (`Column.formula`): it then applies to every row whose own cell is empty, so a cell's own value or
 * formula overrides the column formula until it is cleared, and a new row gets it automatically.
 * The stored text is what the editor shows, the evaluated value is what the grid shows (and sorts
 * and filters by).
 */

export type FormulaCellResult =
  | { ok: true; value: FormulaValue; /** Set when the result comes from the column's formula. */ columnFormula?: string }
  | { ok: false; error: ErrorName; message: string; columnFormula?: string }

/** Scheduling columns keep their stored text: their values come from the scheduler. */
const SCHEDULE_ROLES: readonly ColumnRole[] = ['start', 'end', 'duration', 'predecessor', 'percentComplete']

export const isFormula = (value: unknown): value is string => typeof value === 'string' && value.startsWith('=')

/** Whether formulas in this column are evaluated. */
export const evaluatesFormulas = (col: Column) => !col.role || !SCHEDULE_ROLES.includes(col.role)

/**
 * A formula value as shown in a cell: numbers to 5 decimals (the value itself keeps 15 significant
 * digits), booleans TRUE/FALSE, text as it is, an empty result as ''.
 */
export function formatFormulaValue(value: FormulaValue): string {
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') return String(Number(value.toFixed(5)))
  return value
}

/** The text a formula cell shows: its formatted value, or the error name (#DIVIDE BY ZERO, ...). */
export const formulaDisplay = (r: FormulaCellResult) => (r.ok ? formatFormulaValue(r.value) : r.error)

/** The tooltip of a failed formula: the error name and what it means. */
export const formulaErrorText = (r: Extract<FormulaCellResult, { ok: false }>) => `${r.error}: ${r.message}`

export type FormulaEvaluator = (rowId: string, colId: string) => FormulaCellResult | null

const isBlankRaw = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

const kindOf = (col: Column): CellKind =>
  col.type === 'DATE' ? 'date' : col.type === 'CHECKBOX' ? 'checkbox' : col.type === 'DURATION' ? 'duration' : 'text'
const destOf = (col: Column): Dest =>
  col.type === 'DATE' ? 'D' : col.type === 'CHECKBOX' ? 'B' : col.type === 'DURATION' ? 'U' : 'T'

/** The formula a column holds, with its leading `=` (people may type it with or without). */
export function columnFormulaText(col: Column): string | null {
  const f = col.formula?.trim()
  if (!f) return null
  return f.startsWith('=') ? f : `=${f}`
}

// ------------------------------------------------------------------ engine

/** A cell is a column number and a row index (full tree order) packed into one number. */
const STRIDE = 1 << 22
const packKey = (colNo: number, row: number) => colNo * STRIDE + row
const colOf = (key: number) => Math.floor(key / STRIDE)
const rowOf = (key: number) => key % STRIDE

/** Functions whose direct `[Column]` arguments mean the whole column. */
const LIST_FUNCTIONS = new Set([
  'SUM', 'AVG', 'MIN', 'MAX', 'MEDIAN', 'COUNT', 'COUNTIF', 'SUMIF', 'AVERAGEIF', 'COUNTIFS', 'SUMIFS', 'AVERAGEIFS',
  'JOIN', 'HAS', 'INDEX', 'MATCH', 'DISTINCT', 'CALCPERCENT', 'WORKDAY', 'NETWORKDAYS', 'CALCSTART',
])
const HIERARCHY_FUNCTIONS = new Set(['CHILDREN', 'DESCENDANTS', 'ANCESTORS', 'PARENT'])

/** Cap on remembered sheets (the engine of each stays warm between edits). */
const KEEP_SHEETS = 6

/**
 * Evaluation state of one sheet that survives edits: results are cached per cell together with the
 * cells they read, so an edit drops only the cells that depend (directly or through others) on what
 * changed. A change to the columns, the calendar or the row tree starts over.
 */
class SheetEngine {
  data!: SheetData
  private colList!: Column[]
  private colNo = new Map<string, number>() // column id -> index
  private byTitle = new Map<string, Column>()
  private byLowerTitle = new Map<string, Column>()
  private rows: RowRecord[] = [] // tree order
  private order: string[] = []
  private indexOf = new Map<string, number>()
  private parentIdx: number[] = []
  private childIdx: number[][] = []
  private raw = new Map<string, unknown[]>() // column id -> raw cells in tree order
  private results: (FormulaCellResult | undefined)[][] = []
  private inProgress = new Set<number>()
  private current = -1
  /** cell -> cells that read it; column number -> cells that read (a range of) the whole column */
  private rev = new Map<number, Set<number>>()
  private colRev = new Map<number, Set<number>>()
  /** cells whose result is a circular/blocked error: dropped on every change (the cycle may be broken anywhere). */
  private circular = new Set<number>()
  private inputRows: readonly RowRecord[] = []
  evaluations = 0

  constructor(data: SheetData) {
    this.load(data)
  }

  private load(data: SheetData): void {
    this.data = data
    this.inputRows = data.rows
    this.colList = data.columns
    this.colNo = new Map(data.columns.map((c, i) => [c.id, i]))
    this.byTitle = new Map()
    this.byLowerTitle = new Map()
    for (const c of data.columns) {
      if (!this.byTitle.has(c.title)) this.byTitle.set(c.title, c)
      const lower = c.title.trim().toLowerCase()
      if (!this.byLowerTitle.has(lower)) this.byLowerTitle.set(lower, c)
    }
    const byId = new Map(data.rows.map((r) => [r.id, r]))
    this.order = fullOrder(data.rows)
    this.rows = this.order.map((id) => byId.get(id)!)
    this.indexOf = new Map(this.order.map((id, i) => [id, i]))
    this.parentIdx = this.rows.map((r) => (r.parentId !== null ? (this.indexOf.get(r.parentId) ?? -1) : -1))
    this.childIdx = this.rows.map(() => [])
    this.parentIdx.forEach((p, i) => {
      if (p >= 0) this.childIdx[p].push(i)
    })
    this.raw = new Map()
    this.results = data.columns.map(() => [])
    this.inProgress = new Set()
    this.rev = new Map()
    this.colRev = new Map()
    this.circular = new Set()
  }

  /**
   * Moves to `data` when only cell values changed (same columns and calendar, same rows in the same
   * places), dropping the results that depended on them. Returns false when the sheet changed in
   * another way and the engine must be rebuilt.
   */
  rebase(data: SheetData): boolean {
    const prev = this.data
    if (data.sheet.id !== prev.sheet.id || data.sheet.calendar !== prev.sheet.calendar) return false
    if (data.columns.length !== this.colList.length || data.columns.some((c, i) => c !== this.colList[i])) return false
    if (data.rows.length !== this.inputRows.length) return false
    const changed: { key: number; row: number; colId: string; value: unknown; record: RowRecord }[] = []
    for (let i = 0; i < data.rows.length; i++) {
      const r = data.rows[i]
      const p = this.inputRows[i]
      if (r === p) continue
      if (r.id !== p.id || r.parentId !== p.parentId || r.position !== p.position) return false
      const row = this.indexOf.get(r.id)
      if (row === undefined) return false
      const ids = new Set([...Object.keys(r.cells), ...Object.keys(p.cells)])
      for (const colId of ids) {
        const colNo = this.colNo.get(colId)
        if (colNo !== undefined && r.cells[colId] !== p.cells[colId]) {
          changed.push({ key: packKey(colNo, row), row, colId, value: r.cells[colId], record: r })
        }
      }
      this.rows[row] = r
    }
    this.data = data
    this.inputRows = data.rows
    for (const c of changed) {
      const col = this.raw.get(c.colId)
      if (col) col[c.row] = c.value
    }
    this.invalidate(changed.map((c) => c.key))
    return true
  }

  /** Drops the cached result of each cell and, transitively, of every cell that read it. */
  private invalidate(keys: number[]): void {
    const stack = [...keys, ...this.circular]
    const seen = new Set<number>()
    const columnsDone = new Set<number>()
    while (stack.length > 0) {
      const k = stack.pop()!
      if (seen.has(k)) continue
      seen.add(k)
      const colNo = colOf(k)
      const bucket = this.results[colNo]
      if (bucket) bucket[rowOf(k)] = undefined
      this.circular.delete(k)
      const readers = this.rev.get(k)
      if (readers) for (const d of readers) stack.push(d)
      if (!columnsDone.has(colNo)) {
        columnsDone.add(colNo)
        const all = this.colRev.get(colNo)
        if (all) for (const d of all) stack.push(d)
      }
    }
  }

  private rawColumn(col: Column): unknown[] {
    let values = this.raw.get(col.id)
    if (!values) {
      values = this.rows.map((r) => r.cells[col.id])
      this.raw.set(col.id, values)
    }
    return values
  }

  /** The formula that applies to a cell: its own, else its column's (when the cell is empty). */
  private formulaFor(col: Column, raw: unknown): { text: string; fromColumn: boolean } | null {
    if (!evaluatesFormulas(col)) return null
    if (isFormula(raw)) return { text: raw, fromColumn: false }
    if (col.formula && isBlankRaw(raw)) {
      const text = columnFormulaText(col)
      if (text) return { text, fromColumn: true }
    }
    return null
  }

  private findColumn(title: string): Column | undefined {
    return this.byTitle.get(title) ?? this.byLowerTitle.get(title.trim().toLowerCase())
  }

  private addEdge(target: number): void {
    if (this.current < 0) return
    let s = this.rev.get(target)
    if (!s) this.rev.set(target, (s = new Set()))
    s.add(this.current)
  }

  /** A cell's value for another formula: its stored value, or its evaluated formula (an error is rethrown). */
  private read(col: Column, row: number): unknown {
    const colNo = this.colNo.get(col.id)!
    const key = packKey(colNo, row)
    this.addEdge(key)
    const raw = this.rawColumn(col)[row]
    const f = this.formulaFor(col, raw)
    if (!f) return raw
    if (this.inProgress.has(key)) throw new FormulaError('#CIRCULAR REFERENCE')
    const r = this.evalCell(row, col, f)
    if (!r.ok) throw new FormulaError(r.error, r.message)
    return r.value
  }

  private context(row: number, col: Column, dest: Dest): FormulaContext {
    return {
      rowIndex: row,
      rowCount: this.rows.length,
      ownColumn: col.title,
      dest,
      calendar: this.data.sheet.calendar,
      hasColumn: (title) => this.findColumn(title) !== undefined,
      cellKind: (title) => {
        const c = this.findColumn(title)
        return c ? kindOf(c) : undefined
      },
      cell: (title, i) => this.read(this.findColumn(title)!, i),
      column: (title, from, to) => {
        const c = this.findColumn(title)!
        const colNo = this.colNo.get(c.id)!
        if (this.current >= 0) {
          let s = this.colRev.get(colNo)
          if (!s) this.colRev.set(colNo, (s = new Set()))
          s.add(this.current)
        }
        const out: unknown[] = []
        for (let i = from; i <= to; i++) out.push(this.readInRange(c, i))
        return out
      },
      parent: (i) => (this.parentIdx[i] >= 0 ? this.parentIdx[i] : null),
      children: (i) => this.childIdx[i] ?? [],
    }
  }

  /** Like `read`, without a per-cell edge: the reader already depends on the whole column. */
  private readInRange(col: Column, row: number): unknown {
    const raw = this.rawColumn(col)[row]
    const f = this.formulaFor(col, raw)
    if (!f) return raw
    const key = packKey(this.colNo.get(col.id)!, row)
    if (this.inProgress.has(key)) throw new FormulaError('#CIRCULAR REFERENCE')
    const r = this.evalCell(row, col, f)
    if (!r.ok) throw new FormulaError(r.error, r.message)
    return r.value
  }

  private evalCell(row: number, col: Column, f: { text: string; fromColumn: boolean }): FormulaCellResult {
    const colNo = this.colNo.get(col.id)!
    const bucket = this.results[colNo]
    const cached = bucket[row]
    if (cached) return cached
    const key = packKey(colNo, row)
    const outer = this.current
    this.inProgress.add(key)
    this.current = key
    this.evaluations++
    let r: FormulaCellResult
    try {
      const res = evaluate(f.text, this.context(row, col, destOf(col)))
      r = res
    } finally {
      this.inProgress.delete(key)
      this.current = outer
    }
    if (!r.ok && (r.error === '#CIRCULAR REFERENCE' || r.error === '#BLOCKED')) {
      // On a cycle: circular. Merely depending on one: blocked.
      const onCycle = this.onCycle(key)
      r = { ok: false, error: onCycle ? '#CIRCULAR REFERENCE' : '#BLOCKED', message: r.message }
      this.circular.add(key)
    }
    if (f.fromColumn) r = { ...r, columnFormula: f.text }
    bucket[row] = r
    return r
  }

  // ----------------------------------------------- static dependency graph

  /** The cells a cell's formula may read (every branch), for cycle classification. */
  private staticDeps(key: number): number[] {
    const colNo = colOf(key)
    const row = rowOf(key)
    const col = this.colList[colNo]
    if (!col) return []
    const f = this.formulaFor(col, this.rawColumn(col)[row])
    if (!f) return []
    let ast: Node
    try {
      ast = parseFormula(f.text.slice(1))
    } catch {
      return []
    }
    const out: number[] = []
    const cell = (title: string, r: number) => {
      const c = this.findColumn(title)
      if (c && r >= 0 && r < this.rows.length) out.push(packKey(this.colNo.get(c.id)!, r))
    }
    const column = (title: string, from = 0, to = this.rows.length - 1) => {
      for (let r = from; r <= to; r++) cell(title, r)
    }
    const walk = (n: Node, listContext: boolean): void => {
      switch (n.k) {
        case 'ref':
          if (n.mode === 'same' || (n.mode === 'bare' && !listContext)) cell(n.col, row)
          else if (n.mode === 'bare') column(n.col)
          else if (n.mode === 'row') cell(n.col, (n.row ?? 0) - 1)
          else if (n.row !== undefined && n.row2 !== undefined) column(n.col, Math.min(n.row, n.row2) - 1, Math.max(n.row, n.row2) - 1)
          else column(n.col)
          break
        case 'neg':
          walk(n.e, false)
          break
        case 'bin':
          walk(n.l, false)
          walk(n.r, false)
          break
        case 'call': {
          if (HIERARCHY_FUNCTIONS.has(n.name)) {
            const a = n.args[0]
            const title = a && a.k === 'ref' ? a.col : col.title
            const base = a && a.k === 'ref' && a.mode === 'row' ? (a.row ?? 0) - 1 : row
            if (n.name === 'CHILDREN') for (const c of this.childIdx[base] ?? []) cell(title, c)
            else if (n.name === 'PARENT') cell(title, this.parentIdx[base] ?? -1)
            else if (n.name === 'ANCESTORS') for (let p = this.parentIdx[base]; p >= 0; p = this.parentIdx[p]) cell(title, p)
            else {
              const stack = [...(this.childIdx[base] ?? [])]
              while (stack.length > 0) {
                const r = stack.pop()!
                cell(title, r)
                stack.push(...this.childIdx[r])
              }
            }
          } else for (const a of n.args) walk(a, LIST_FUNCTIONS.has(n.name))
          break
        }
        default:
          break
      }
    }
    walk(ast, false)
    return out
  }

  /** Whether the cell lies on a dependency cycle (it can reach itself). */
  private onCycle(start: number): boolean {
    const seen = new Set<number>()
    const stack = [start]
    while (stack.length > 0) {
      const k = stack.pop()!
      for (const d of this.staticDeps(k)) {
        if (d === start) return true
        if (!seen.has(d)) {
          seen.add(d)
          stack.push(d)
        }
      }
    }
    return false
  }

  // ------------------------------------------------------------------ API

  get(rowId: string, colId: string): FormulaCellResult | null {
    const row = this.indexOf.get(rowId)
    const colNo = this.colNo.get(colId)
    if (row === undefined || colNo === undefined) return null
    const col = this.colList[colNo]
    const f = this.formulaFor(col, this.rawColumn(col)[row])
    return f ? this.evalCell(row, col, f) : null
  }
}

const cache = new WeakMap<SheetData, FormulaEvaluator>()
const engines = new Map<string, SheetEngine>()

/**
 * The evaluator for one SheetData, memoized per object identity (every edit makes a new one).
 * Returns null for a cell that is not an evaluated formula. Results are cached per cell; the engine
 * of the previous version of the same sheet is reused when only cell values changed, so an edit
 * recomputes just the cells that depend on it. Evaluation is lazy: only cells that are shown, sorted
 * or filtered by (and what they read) are computed.
 */
export function formulaEvaluator(data: SheetData): FormulaEvaluator {
  let ev = cache.get(data)
  if (ev) return ev
  let engine = engines.get(data.sheet.id)
  if (!engine || !engine.rebase(data)) engine = new SheetEngine(data)
  engines.delete(data.sheet.id)
  engines.set(data.sheet.id, engine) // most recently used last
  if (engines.size > KEEP_SHEETS) engines.delete(engines.keys().next().value as string)
  const owner = engine
  ev = (rowId, colId) => {
    if (owner.data !== data) {
      // A newer version of the sheet took the engine over: this one is out of date, start afresh.
      cache.delete(data)
      return formulaEvaluator(data)(rowId, colId)
    }
    return owner.get(rowId, colId)
  }
  cache.set(data, ev)
  return ev
}

/** For tests and measurements: how many formula cells the engine of `data` has evaluated so far. */
export function evaluationCount(data: SheetData): number {
  formulaEvaluator(data)
  return engines.get(data.sheet.id)?.evaluations ?? 0
}

/**
 * What a column formula would give in one row, without saving it: the row's own cell is treated as
 * empty so the formula applies. Used by the column-formula dialog's live preview.
 */
export function previewColumnFormula(data: SheetData, colId: string, formula: string, rowId: string): FormulaCellResult | null {
  const col = data.columns.find((c) => c.id === colId)
  if (!col) return null
  const trial: SheetData = {
    ...data,
    columns: data.columns.map((c) => (c.id === colId ? { ...c, formula } : c)),
    rows: data.rows.map((r) => {
      if (r.id !== rowId || !(colId in r.cells)) return r
      const { [colId]: _own, ...cells } = r.cells
      return { ...r, cells }
    }),
  }
  return new SheetEngine(trial).get(rowId, colId)
}
