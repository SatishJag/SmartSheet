/**
 * Values, errors and date helpers shared by the formula parser, interpreter and sheet layer.
 * Pure and dependency-free (the one import is a type).
 */

// ------------------------------------------------------------------ errors

/** The error names the reference product shows in a cell (docs/behavior/formulas.md). */
export type ErrorName =
  | '#DIVIDE BY ZERO'
  | '#UNPARSEABLE'
  | '#INCORRECT ARGUMENT SET'
  | '#INVALID DATA TYPE'
  | '#INVALID OPERATION'
  | '#INVALID VALUE'
  | '#INVALID REF'
  | '#CIRCULAR REFERENCE'
  | '#BLOCKED'
  | '#DATE EXPECTED'
  | '#BOOLEAN EXPECTED'
  | '#INVALID COLUMN VALUE'

/** A short, user-facing explanation of each error (shown as the cell tooltip). */
export const ERROR_HELP: Record<ErrorName, string> = {
  '#DIVIDE BY ZERO': 'The formula divides by zero (or averages nothing).',
  '#UNPARSEABLE': 'The formula could not be read: check the syntax, function names and column names.',
  '#INCORRECT ARGUMENT SET': 'A function was given the wrong number of arguments.',
  '#INVALID DATA TYPE': 'A value has the wrong type for this function or operator (for example text where a number is needed).',
  '#INVALID OPERATION': 'This operator does not work on these kinds of values (for example adding a checkbox to a number).',
  '#INVALID VALUE': 'A value is outside what the function accepts (for example month 13, or VALUE("x")).',
  '#INVALID REF': 'A reference cannot be used here: array literals, {cross-sheet} references and out-of-range rows are not supported.',
  '#CIRCULAR REFERENCE': 'The formula depends on its own result, directly or through other cells.',
  '#BLOCKED': 'The formula depends on a cell that has a circular reference.',
  '#DATE EXPECTED': 'The formula returned something that is not a date, and this is a date column.',
  '#BOOLEAN EXPECTED': 'The formula returned something that is not true/false, and this is a checkbox column.',
  '#INVALID COLUMN VALUE': 'The formula returned a value this column cannot hold (a checkbox or a date in a text/number column).',
}

export class FormulaError extends Error {
  constructor(
    readonly code: ErrorName,
    detail?: string,
  ) {
    super(detail ?? ERROR_HELP[code])
  }
}

export function fail(code: ErrorName, detail?: string): never {
  throw new FormulaError(code, detail)
}

// ------------------------------------------------------------------ values

/** A calendar date, as days since 1970-01-01 (UTC). */
export interface DateVal {
  readonly t: 'date'
  readonly day: number
}
/** A list of values (a column range, CHILDREN(...), ...). Only function arguments, never a cell result. */
export interface ListVal {
  readonly t: 'list'
  readonly items: readonly Val[]
}
/** An empty cell. `date` blanks come from a date column (arithmetic on them stays blank). */
export interface BlankVal {
  readonly t: 'blank'
  readonly date: boolean
}
export type Val = number | string | boolean | DateVal | ListVal | BlankVal

export const BLANK: BlankVal = { t: 'blank', date: false }
export const BLANK_DATE: BlankVal = { t: 'blank', date: true }

export const mkDate = (day: number): DateVal => ({ t: 'date', day })
export const mkList = (items: readonly Val[]): ListVal => ({ t: 'list', items })

export const isDate = (v: Val): v is DateVal => typeof v === 'object' && v.t === 'date'
export const isList = (v: Val): v is ListVal => typeof v === 'object' && v.t === 'list'
export const isBlank = (v: Val): v is BlankVal => typeof v === 'object' && v.t === 'blank'

/** The type of value a formula may produce for a cell; the destination column decides which are allowed. */
export type Dest = 'T' | 'B' | 'D' | 'U' | 'any'

/** What a formula cell holds once finished: ISO text for dates, null for an empty result. */
export type FormulaValue = number | string | boolean | null

// ------------------------------------------------------------------- dates

const DAY_MS = 86_400_000
export const MIN_DAY = -719_162 // 0001-01-01
export const MAX_DAY = 2_932_896 // 9999-12-31

/** Days since the epoch of a real calendar date, or null. Years 1..9999. */
export function ymdToDay(y: number, m: number, d: number): number | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null
  const date = new Date(0)
  date.setUTCFullYear(y, m - 1, d)
  const day = Math.floor(date.getTime() / DAY_MS)
  return day >= MIN_DAY && day <= MAX_DAY ? day : null
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/

/** Epoch day of a strict YYYY-MM-DD string naming a real date, else null. */
export function isoToDay(iso: string): number | null {
  const m = ISO.exec(iso)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const day = ymdToDay(y, mo, d)
  if (day === null) return null
  const check = new Date(day * DAY_MS)
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d ? day : null
}

export function dayToIso(day: number): string {
  const d = new Date(day * DAY_MS)
  const y = String(d.getUTCFullYear()).padStart(4, '0')
  return `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 0 = Sunday ... 6 = Saturday. */
export const weekdayOf = (day: number): number => (((day + 4) % 7) + 7) % 7

export function yearOf(day: number): number {
  return new Date(day * DAY_MS).getUTCFullYear()
}
export function monthOf(day: number): number {
  return new Date(day * DAY_MS).getUTCMonth() + 1
}
export function dayOfMonth(day: number): number {
  return new Date(day * DAY_MS).getUTCDate()
}
export function dayOfYear(day: number): number {
  const y = yearOf(day)
  return day - (ymdToDay(y, 1, 1) as number) + 1
}

// ------------------------------------------------------------------ numbers

/** A number as text (up to 15 significant digits, no trailing noise). */
export function numToText(n: number): string {
  return String(Number(n.toPrecision(15)))
}

/** The value kept in a cell: 15 significant digits, never -0. */
export function cleanNumber(n: number): number {
  const r = Number(n.toPrecision(15))
  return r === 0 ? 0 : r
}

/** Shifts the decimal point of `x` by `e` places exactly (string arithmetic, no 2.675*100 noise). */
export function shiftDecimal(x: number, e: number): number {
  const [mantissa, exp = '0'] = String(x).split('e')
  return Number(`${mantissa}e${Number(exp) + e}`)
}

const STRICT_NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)$/
/** Whether text is, entirely, a plain decimal number. */
export const isNumericText = (s: string) => STRICT_NUMERIC.test(s.trim())

// ---------------------------------------------------------------- finishing

/**
 * The final value of a formula cell for its destination column (docs/behavior/formulas.md): a
 * boolean fits only a checkbox, a date only a date column, a number a checkbox only as 0/1 and a
 * date column only as 0 (empty); text fits anywhere. Throws the matching error name otherwise.
 */
export function finish(v: Val, dest: Dest, formatDays?: (days: number) => string): FormulaValue {
  if (isList(v)) fail('#INVALID VALUE', 'A formula cannot return a list: wrap it in SUM, COUNT, JOIN, ...')
  if (isBlank(v)) return dest === 'B' ? false : null
  if (typeof v === 'string') return v
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail('#INVALID VALUE', 'The result is not a finite number')
    const n = cleanNumber(v)
    switch (dest) {
      case 'B':
        return n === 1 ? true : n === 0 ? false : fail('#BOOLEAN EXPECTED')
      case 'D':
        return n === 0 ? null : fail('#DATE EXPECTED')
      case 'U':
        return formatDays ? formatDays(n) : `${n}d`
      default:
        return n
    }
  }
  if (typeof v === 'boolean') {
    switch (dest) {
      case 'D':
        return fail('#DATE EXPECTED')
      case 'T':
      case 'U':
        return fail('#INVALID COLUMN VALUE')
      default:
        return v
    }
  }
  // a date
  switch (dest) {
    case 'B':
      return fail('#BOOLEAN EXPECTED')
    case 'T':
    case 'U':
      return fail('#INVALID COLUMN VALUE')
    default:
      return dayToIso(v.day)
  }
}
