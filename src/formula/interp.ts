/**
 * The formula interpreter: evaluates a parsed AST against a FormulaContext. Typed values
 * (numbers, text, booleans, dates, blanks, lists), operators with the reference product's type
 * rules, and the cell/range/hierarchy readers the functions build on. Errors are thrown as
 * FormulaError and caught by `evaluate()`.
 */
import { defaultCalendar } from '../engine/calendar'
import type { Calendar } from '../engine/types'
import { parseDuration } from '../engine/duration'
import { FUNCS } from './functions'
import type { Node, RefNode } from './parse'
import {
  BLANK,
  BLANK_DATE,
  MAX_DAY,
  MIN_DAY,
  fail,
  isBlank,
  isDate,
  isList,
  isNumericText,
  isoToDay,
  mkDate,
  mkList,
  numToText,
  dayToIso,
  type BlankVal,
  type Dest,
  type Val,
} from './values'

/** How a column's cells are read as typed values. */
export type CellKind = 'text' | 'date' | 'checkbox' | 'duration'

export interface FormulaContext {
  /** 0-based row of the formula in the sheet's full tree order. */
  rowIndex: number
  rowCount: number
  hasColumn(title: string): boolean
  /** The cell's value (an evaluated value when it is a formula cell; throws a FormulaError when that is an error). */
  cell(colTitle: string, rowIndex: number): unknown
  /** The cells of rows from..to (inclusive) of a column, in one call (lets the sheet track a column dependency once). */
  column?(colTitle: string, from: number, to: number): unknown[]
  /** How the column's cells are typed; defaults to 'text' (numbers stay numbers, numeric text is a number). */
  cellKind?(colTitle: string): CellKind | undefined
  /** The column this formula is in: the default of CHILDREN(), PARENT(), ... */
  ownColumn?: string
  parent?(rowIndex: number): number | null
  /** Direct children, in order. */
  children?(rowIndex: number): readonly number[]
  /** ISO YYYY-MM-DD used by TODAY(). Defaults to the real current UTC date. */
  today?: string
  /** Working days for WORKDAY, NETWORKDAYS and CALC*; defaults to Monday to Friday, 8 h days. */
  calendar?: Calendar
  /** The destination column's kind; decides which result types are allowed. Default: no restriction. */
  dest?: Dest
}

/** One argument of an aggregate, with whether it came from cells (non-numbers are skipped) or was typed in. */
export interface Item {
  v: Val
  fromCells: boolean
}

const nonWorkingCache = new WeakMap<Calendar, Set<number>>()
function nonWorkingDays(cal: Calendar): Set<number> {
  let s = nonWorkingCache.get(cal)
  if (!s) {
    s = new Set()
    for (const iso of cal.nonWorkingDates) {
      const d = isoToDay(iso)
      if (d !== null) s.add(d)
    }
    nonWorkingCache.set(cal, s)
  }
  return s
}

export class Interp {
  constructor(readonly ctx: FormulaContext) {}

  // ---------------------------------------------------------- evaluation

  eval(n: Node): Val {
    switch (n.k) {
      case 'num':
      case 'str':
      case 'bool':
        return n.v
      case 'bad':
        return fail('#INVALID REF', `${n.text} is not supported: array literals and {cross-sheet} references are not available yet`)
      case 'ref':
        return this.ref(n)
      case 'neg': {
        const v = this.eval(n.e)
        if (isBlank(v)) return 0
        if (typeof v === 'number') return -v === 0 ? 0 : -v
        if (typeof v === 'string' || isList(v)) return fail('#INVALID DATA TYPE', 'The minus sign needs a number')
        return fail('#INVALID OPERATION', 'The minus sign needs a number')
      }
      case 'bin':
        return this.binary(n.op, this.eval(n.l), this.eval(n.r))
      case 'call': {
        const fn = FUNCS[n.name]
        if (!fn) return fail('#UNPARSEABLE', `Unknown function '${n.name}'`)
        return fn(this, n.args)
      }
    }
  }

  /** A value that must not be a list. */
  scalar(n: Node): Val {
    const v = this.eval(n)
    if (isList(v)) return fail('#INVALID DATA TYPE', 'A range or list cannot be used where a single value is expected')
    return v
  }

  // ----------------------------------------------------------- coercions

  num(n: Node): number {
    return this.toNum(this.scalar(n))
  }

  toNum(v: Val): number {
    if (typeof v === 'number') return v
    if (isBlank(v)) return 0
    return fail('#INVALID DATA TYPE', 'A number is needed here')
  }

  int(n: Node): number {
    const x = this.num(n)
    return Math.trunc(x)
  }

  text(n: Node): string {
    return this.toText(this.scalar(n))
  }

  toText(v: Val): string {
    if (typeof v === 'string') return v
    if (typeof v === 'number') return numToText(v)
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
    if (isBlank(v)) return ''
    if (isDate(v)) return dayToIso(v.day)
    return fail('#INVALID DATA TYPE', 'A range or list cannot be used as text')
  }

  /** IF/AND/OR/NOT condition: a boolean, or exactly 0 or 1. */
  bool(n: Node): boolean {
    const v = this.scalar(n)
    if (typeof v === 'boolean') return v
    if (v === 1) return true
    if (v === 0) return false
    return fail('#INVALID DATA TYPE', 'A condition must be true/false (or 1/0)')
  }

  /** An epoch day, or null for a blank. Dates, and text written as YYYY-MM-DD, are accepted. */
  dayOf(v: Val): number | null {
    if (isDate(v)) return v.day
    if (isBlank(v)) return null
    if (typeof v === 'string') {
      const d = isoToDay(v)
      if (d !== null) return d
    }
    return fail('#INVALID DATA TYPE', 'A date is needed here')
  }

  day(n: Node): number | null {
    return this.dayOf(this.scalar(n))
  }

  // ---------------------------------------------------------- references

  columnKind(col: string): CellKind {
    return this.ctx.cellKind?.(col) ?? 'text'
  }

  /** A cell as a typed value. */
  readCell(col: string, row: number): Val {
    if (!this.ctx.hasColumn(col)) return fail('#UNPARSEABLE', `Unknown column '${col}'`)
    return this.fromRaw(this.ctx.cell(col, row), this.columnKind(col))
  }

  fromRaw(raw: unknown, kind: CellKind): Val {
    if (kind === 'checkbox') return raw === true
    if (kind === 'date') {
      if (raw === null || raw === undefined || raw === '') return BLANK_DATE
      if (typeof raw === 'string') {
        const d = isoToDay(raw)
        return d === null ? raw : mkDate(d)
      }
    }
    if (raw === null || raw === undefined || raw === '') return BLANK
    if (Array.isArray(raw)) return raw.length === 0 ? BLANK : raw.join(', ')
    if (typeof raw === 'number' || typeof raw === 'boolean') return raw
    const s = String(raw)
    if (kind === 'duration') {
      const d = parseDuration(s, this.calendar().hoursPerDay)
      if (d) return d.minutes / ((d.elapsed ? 24 : this.calendar().hoursPerDay) * 60)
    }
    return isNumericText(s) ? Number(s) : s
  }

  private ref(n: RefNode): Val {
    switch (n.mode) {
      case 'same':
      case 'bare':
        return this.readCell(n.col, this.ctx.rowIndex)
      case 'row': {
        const r = n.row ?? 0
        if (r < 1 || r > this.ctx.rowCount) return fail('#INVALID REF', `Row ${r} does not exist`)
        return this.readCell(n.col, r - 1)
      }
      case 'range':
        return mkList(this.rangeCells(n))
    }
  }

  /** The cells of `Col:Col` (all rows) or `[Col]a:[Col]b`. */
  rangeCells(n: RefNode): Val[] {
    if (n.col2 !== undefined && n.col2.trim().toLowerCase() !== n.col.trim().toLowerCase()) {
      return fail('#INVALID REF', 'A range must stay within one column')
    }
    return this.columnCells(n.col, n.row, n.row2)
  }

  columnCells(col: string, firstRow?: number, lastRow?: number): Val[] {
    if (!this.ctx.hasColumn(col)) return fail('#UNPARSEABLE', `Unknown column '${col}'`)
    let from = 0
    let to = this.ctx.rowCount - 1
    if (firstRow !== undefined && lastRow !== undefined) {
      from = Math.min(firstRow, lastRow) - 1
      to = Math.max(firstRow, lastRow) - 1
      if (from < 0 || to >= this.ctx.rowCount) return fail('#INVALID REF', 'The row range is outside the sheet')
    }
    if (this.ctx.column) {
      const kind = this.columnKind(col)
      return this.ctx.column(col, from, to).map((raw) => this.fromRaw(raw, kind))
    }
    const out: Val[] = []
    for (let r = from; r <= to; r++) out.push(this.readCell(col, r))
    return out
  }

  // ------------------------------------------------ lists and aggregates

  /** The values behind an argument, flattened: ranges and lists skip non-numbers where numbers are summed. */
  items(n: Node): Item[] {
    if (n.k === 'ref' && n.mode === 'bare') return this.columnCells(n.col).map((v) => ({ v, fromCells: true }))
    if (n.k === 'ref' && n.mode !== 'range') return [{ v: this.ref(n), fromCells: true }]
    const v = this.eval(n)
    if (isList(v)) return v.items.map((x) => ({ v: x, fromCells: true }))
    return [{ v, fromCells: n.k === 'ref' }]
  }

  /** A range-like argument as plain values (a single value counts as a list of one). */
  list(n: Node): Val[] {
    if (n.k === 'ref' && n.mode === 'bare') return this.columnCells(n.col)
    const v = this.eval(n)
    return isList(v) ? [...v.items] : [v]
  }

  // ----------------------------------------------------------- hierarchy

  /** The column and row a hierarchy function looks from: its argument, or this cell. */
  hierarchyTarget(args: Node[]): { col: string; row: number } {
    if (args.length === 0) {
      if (!this.ctx.ownColumn) return fail('#INVALID REF', 'Give the cell to start from, e.g. CHILDREN([Cost]@row)')
      return { col: this.ctx.ownColumn, row: this.ctx.rowIndex }
    }
    const a = args[0]
    if (a.k !== 'ref' || a.mode === 'range') return fail('#INVALID REF', 'Give a cell reference such as [Cost]@row')
    if (a.mode === 'row') {
      const r = a.row ?? 0
      if (r < 1 || r > this.ctx.rowCount) return fail('#INVALID REF', `Row ${r} does not exist`)
      return { col: a.col, row: r - 1 }
    }
    return { col: a.col, row: this.ctx.rowIndex }
  }

  childRows(row: number): readonly number[] {
    return this.ctx.children?.(row) ?? []
  }

  descendantRows(row: number): number[] {
    const out: number[] = []
    const stack = [...this.childRows(row)].reverse()
    while (stack.length > 0) {
      const r = stack.pop()!
      out.push(r)
      const kids = this.childRows(r)
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
    }
    return out
  }

  ancestorRows(row: number): number[] {
    const out: number[] = []
    for (let p = this.ctx.parent?.(row) ?? null; p !== null && !out.includes(p); p = this.ctx.parent?.(p) ?? null) out.push(p)
    return out
  }

  // ------------------------------------------------------------ calendar

  calendar(): Calendar {
    return this.ctx.calendar ?? defaultCalendar
  }

  /** Whether a day is a working day in the sheet calendar (and not one of the extra holidays). */
  isWorking(day: number, holidays?: ReadonlySet<number>): boolean {
    const cal = this.calendar()
    return cal.workingWeekdays.includes(((day + 4) % 7 + 7) % 7) && !nonWorkingDays(cal).has(day) && !(holidays?.has(day) ?? false)
  }

  holidaySet(n: Node | undefined): ReadonlySet<number> | undefined {
    if (!n) return undefined
    const s = new Set<number>()
    for (const v of this.list(n)) {
      const d = isDate(v) ? v.day : typeof v === 'string' ? isoToDay(v) : null
      if (d !== null) s.add(d)
    }
    return s
  }

  // ----------------------------------------------------------- operators

  private binary(op: string, a: Val, b: Val): Val {
    if (isList(a) || isList(b)) return fail('#INVALID DATA TYPE', 'A range or list cannot be used with an operator; wrap it in SUM, COUNT, ...')
    switch (op) {
      case '+':
        return this.add(a, b)
      case '-':
        return this.sub(a, b)
      case '*':
      case '/':
      case '^':
        return this.mulDivPow(op, a, b)
      default:
        return this.compare(op, a, b)
    }
  }

  private checkDay(day: number): Val {
    if (!Number.isFinite(day) || day < MIN_DAY || day > MAX_DAY) return fail('#INVALID VALUE', 'The date is out of range')
    return mkDate(day)
  }

  private add(a: Val, b: Val): Val {
    // A blank date stays blank next to a number or a date; next to a blank number the sum is meaningless.
    if ((isBlank(a) && a.date) || (isBlank(b) && b.date)) {
      const other = isBlank(a) && a.date ? b : a
      if (isBlank(other) && !other.date) return fail('#INVALID OPERATION', 'A date and a blank number cannot be added')
      if (typeof other === 'number' || isDate(other) || isBlank(other)) return BLANK_DATE
    }
    if (typeof a === 'boolean' || typeof b === 'boolean') return fail('#INVALID OPERATION', 'A checkbox/boolean cannot be added')
    if (typeof a === 'string' || typeof b === 'string') return this.toText(a) + this.toText(b) // text concatenation: there is no & operator
    if (isDate(a) && isDate(b)) return fail('#INVALID OPERATION', 'Two dates cannot be added')
    if (isDate(a)) return this.checkDay(a.day + Math.trunc(this.toNum(b)))
    if (isDate(b)) return this.checkDay(b.day + Math.trunc(this.toNum(a)))
    return this.toNum(a) + this.toNum(b)
  }

  private sub(a: Val, b: Val): Val {
    if ((isBlank(a) && a.date) || (isBlank(b) && b.date)) {
      const other = isBlank(a) && a.date ? b : a
      if (isBlank(other) && !other.date) return fail('#INVALID OPERATION', 'A date and a blank number cannot be subtracted')
      if (typeof other === 'number' || isDate(other) || isBlank(other)) return BLANK_DATE
    }
    if (typeof a === 'string' || typeof b === 'string') return fail('#INVALID DATA TYPE', 'Text cannot be subtracted')
    if (typeof a === 'boolean' || typeof b === 'boolean') return fail('#INVALID OPERATION', 'A checkbox/boolean cannot be subtracted')
    if (isDate(a) && isDate(b)) return a.day - b.day
    if (isDate(a)) return this.checkDay(a.day - Math.trunc(this.toNum(b)))
    if (isDate(b)) return fail('#INVALID OPERATION', 'A date cannot be subtracted from a number')
    return this.toNum(a) - this.toNum(b)
  }

  private mulDivPow(op: string, a: Val, b: Val): Val {
    if (typeof a === 'string' || typeof b === 'string') return fail('#INVALID DATA TYPE', `Text cannot be used with ${op}`)
    if (typeof a === 'boolean' || typeof b === 'boolean' || isDate(a) || isDate(b)) {
      return fail('#INVALID OPERATION', `${op} needs numbers`)
    }
    const x = this.toNum(a)
    const y = this.toNum(b)
    if (op === '*') return x * y
    if (op === '/') return y === 0 ? fail('#DIVIDE BY ZERO') : x / y
    if (x === 0 && y < 0) return fail('#DIVIDE BY ZERO')
    const r = Math.pow(x, y)
    return Number.isFinite(r) ? r : fail('#INVALID VALUE', 'The result is not a real number')
  }

  /** Three-way comparison of two values of comparable types, or null when they cannot be ordered. */
  private order(a: Val, b: Val): number | null {
    const cmp = (x: number | string, y: number | string) => (x < y ? -1 : x > y ? 1 : 0)
    if (typeof a === 'number' && typeof b === 'number') return cmp(a, b)
    if (typeof a === 'string' && typeof b === 'string') {
      if (isNumericText(a) && isNumericText(b)) return cmp(Number(a), Number(b)) // numbers stored as text
      return cmp(a.toLowerCase(), b.toLowerCase())
    }
    if (typeof a === 'boolean' && typeof b === 'boolean') return cmp(Number(a), Number(b))
    if (isDate(a) && isDate(b)) return cmp(a.day, b.day)
    if (isDate(a) && typeof b === 'string') {
      const d = isoToDay(b)
      return d === null ? null : cmp(a.day, d)
    }
    if (typeof a === 'string' && isDate(b)) {
      const d = isoToDay(a)
      return d === null ? null : cmp(d, b.day)
    }
    if (typeof a === 'number' && typeof b === 'string') return isNumericText(b) ? cmp(a, Number(b)) : null
    if (typeof a === 'string' && typeof b === 'number') return isNumericText(a) ? cmp(Number(a), b) : null
    return null
  }

  compare(op: string, a: Val, b: Val): boolean {
    let result: number | null
    if (isBlank(a) || isBlank(b)) {
      if (isBlank(a) && isBlank(b)) result = 0
      else {
        const blank = (isBlank(a) ? a : b) as BlankVal
        const other = isBlank(a) ? b : a
        const flip = isBlank(a) ? 1 : -1
        if (isDate(other) || blank.date) result = null
        else if (typeof other === 'number') result = (0 < other ? -1 : 0 > other ? 1 : 0) * flip
        else if (typeof other === 'string') result = (other === '' ? 0 : -1) * flip
        else if (typeof other === 'boolean') result = (other ? -1 : 0) * flip
        else result = null
      }
    } else result = this.order(a, b)
    if (result === null) {
      if (op === '=') return false
      if (op === '<>') return true
      // A blank date (or text next to a number) has no order: ordering comparisons are simply false.
      if ((isBlank(a) && a.date) || (isBlank(b) && b.date)) return false
      return fail('#INVALID DATA TYPE', 'These values cannot be compared')
    }
    switch (op) {
      case '<':
        return result < 0
      case '>':
        return result > 0
      case '<=':
        return result <= 0
      case '>=':
        return result >= 0
      case '=':
        return result === 0
      default:
        return result !== 0
    }
  }
}
