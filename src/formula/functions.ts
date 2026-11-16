/**
 * Implementations of the formula functions (the registry has their signatures and argument
 * counts). Each takes the interpreter and the UNEVALUATED argument nodes, so IF/IFERROR can be
 * lazy and aggregates can tell a typed-in value from a cell.
 */
import type { Interp } from './interp'
import type { Node } from './parse'
import {
  BLANK,
  BLANK_DATE,
  FormulaError,
  cleanNumber,
  dayOfMonth,
  dayOfYear,
  fail,
  isBlank,
  isDate,
  isList,
  isNumericText,
  isoToDay,
  mkDate,
  mkList,
  MAX_DAY,
  MIN_DAY,
  monthOf,
  shiftDecimal,
  weekdayOf,
  yearOf,
  ymdToDay,
  type Val,
} from './values'

type Fn = (it: Interp, args: Node[]) => Val

// ------------------------------------------------------------------ helpers

const MAX_SPAN_DAYS = 36_600

/** Applies a one-number function. */
const math1 = (fn: (x: number) => number): Fn => (it, [a]) => fn(it.num(a))

function roundTo(x: number, digits: number, how: (abs: number) => number): number {
  const d = Math.trunc(digits)
  const abs = Math.abs(x)
  return Math.sign(x) * shiftDecimal(how(shiftDecimal(abs, d)), -d)
}

/** The numbers of an aggregate's arguments: typed-in values must be numbers, cell values that are not numbers are skipped. */
function numbers(it: Interp, args: Node[]): number[] {
  const out: number[] = []
  for (const a of args) {
    for (const { v, fromCells } of it.items(a)) {
      if (typeof v === 'number') out.push(v)
      else if (isBlank(v)) continue
      else if (!fromCells) fail('#INVALID DATA TYPE', 'Only numbers can be added or averaged here')
    }
  }
  return out
}

/** Dates and numbers for MIN/MAX: all dates, or all numbers. */
function extremes(it: Interp, args: Node[]): { nums: number[]; days: number[] } {
  const nums: number[] = []
  const days: number[] = []
  for (const a of args) {
    for (const { v, fromCells } of it.items(a)) {
      if (typeof v === 'number') nums.push(v)
      else if (isDate(v)) days.push(v.day)
      else if (isBlank(v)) continue
      else if (!fromCells) fail('#INVALID DATA TYPE', 'Only numbers and dates can be compared here')
    }
  }
  if (nums.length > 0 && days.length > 0) fail('#INVALID DATA TYPE', 'Numbers and dates cannot be mixed')
  return { nums, days }
}

// ------------------------------------------------------------- conditional

type Matcher = (v: Val) => boolean

function wildcardRegex(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${body}$`, 'is')
}

/** A COUNTIF-style criterion: a value (equals) or text such as ">1", "<>done", "a*". */
function criterion(it: Interp, c: Val): Matcher {
  let op = '='
  let operand: Val = c
  if (typeof c === 'string') {
    const m = /^(<>|<=|>=|<|>|=)?([\s\S]*)$/.exec(c)!
    op = m[1] ?? '='
    const text = m[2].trim()
    const day = isoToDay(text)
    operand = isNumericText(text) ? Number(text) : day !== null ? mkDate(day) : m[2]
  } else if (isBlank(c)) operand = ''
  const wild = typeof operand === 'string' && /[*?]/.test(operand) && (op === '=' || op === '<>') ? wildcardRegex(operand) : null
  return (v) => {
    if (isList(v)) return false
    if (wild) {
      const hit = typeof v === 'string' && wild.test(v)
      return op === '=' ? hit : !hit
    }
    if (isBlank(v)) {
      const empty = operand === ''
      return op === '=' ? empty : op === '<>' ? !empty : false
    }
    if (typeof operand === 'string' && operand === '' && (op === '=' || op === '<>')) return op === '=' ? v === '' : v !== ''
    try {
      return it.compare(op, v, operand)
    } catch (e) {
      if (e instanceof FormulaError) return false // values of another type simply do not match
      throw e
    }
  }
}

function sameLength(lists: Val[][]): void {
  if (lists.some((l) => l.length !== lists[0].length)) fail('#INCORRECT ARGUMENT SET', 'The ranges must have the same size')
}

/** Rows where every (range, criterion) pair matches, as indexes. */
function matchingRows(it: Interp, pairs: Node[], base?: Val[]): number[] {
  const lists: Val[][] = []
  const tests: Matcher[] = []
  for (let i = 0; i < pairs.length; i += 2) {
    lists.push(it.list(pairs[i]))
    tests.push(criterion(it, it.scalar(pairs[i + 1])))
  }
  sameLength(base ? [base, ...lists] : lists)
  const out: number[] = []
  for (let r = 0; r < lists[0].length; r++) if (tests.every((t, k) => t(lists[k][r]))) out.push(r)
  return out
}

function ifFamily(kind: 'count' | 'sum' | 'avg', multi: boolean): Fn {
  return (it, args) => {
    let rows: number[]
    let target: Val[] | null = null
    if (kind === 'count') {
      if (multi && args.length % 2 !== 0) fail('#INCORRECT ARGUMENT SET', 'COUNTIFS takes pairs of range and criterion')
      rows = matchingRows(it, args)
    } else if (multi) {
      if (args.length % 2 !== 1) fail('#INCORRECT ARGUMENT SET', 'SUMIFS/AVERAGEIFS take a range followed by pairs of range and criterion')
      target = it.list(args[0])
      rows = matchingRows(it, args.slice(1), target)
    } else {
      // SUMIF(range, criterion, [sum_range])
      const range = it.list(args[0])
      target = args[2] ? it.list(args[2]) : range
      sameLength([range, target])
      rows = matchingRows(it, args.slice(0, 2))
    }
    if (kind === 'count') return rows.length
    const nums = rows.map((r) => target![r]).filter((v): v is number => typeof v === 'number')
    if (kind === 'sum') return nums.reduce((s, x) => s + x, 0)
    return nums.length === 0 ? fail('#DIVIDE BY ZERO', 'No matching numbers to average') : nums.reduce((s, x) => s + x, 0) / nums.length
  }
}

// ------------------------------------------------------------------- dates

/** A one-date-argument function; a blank date gives a blank result. */
const dateFn = (fn: (day: number) => Val): Fn => (it, [a]) => {
  const d = it.day(a)
  return d === null ? BLANK : fn(d)
}

/** Working days in [lo, hi], both included. */
function countWorking(it: Interp, a: number, b: number, holidays?: ReadonlySet<number>): number {
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  if (hi - lo > MAX_SPAN_DAYS) fail('#INVALID VALUE', 'The dates are too far apart')
  let n = 0
  for (let d = lo; d <= hi; d++) if (it.isWorking(d, holidays)) n++
  return n
}

function addWorking(it: Interp, from: number, n: number, holidays?: ReadonlySet<number>): number {
  if (it.calendar().workingWeekdays.length === 0) fail('#INVALID VALUE', 'The calendar has no working days')
  if (Math.abs(n) > MAX_SPAN_DAYS) fail('#INVALID VALUE', 'Too many days')
  const step = n < 0 ? -1 : 1
  let left = Math.abs(n)
  let d = from
  let guard = 0
  while (left > 0) {
    d += step
    if (it.isWorking(d, holidays)) left--
    if (++guard > MAX_SPAN_DAYS * 8) fail('#INVALID VALUE', 'No working day found')
  }
  return d
}

const checkedDate = (day: number): Val =>
  Number.isFinite(day) && day >= MIN_DAY && day <= MAX_DAY ? mkDate(day) : fail('#INVALID VALUE', 'The date is out of range')

// ------------------------------------------------------------------- table

export const FUNCS: Record<string, Fn | undefined> = {
  // ---- math
  ABS: math1(Math.abs),
  ROUND: (it, a) => roundTo(it.num(a[0]), a[1] ? it.num(a[1]) : 0, Math.round),
  ROUNDUP: (it, a) => roundTo(it.num(a[0]), a[1] ? it.num(a[1]) : 0, Math.ceil),
  ROUNDDOWN: (it, a) => roundTo(it.num(a[0]), a[1] ? it.num(a[1]) : 0, Math.floor),
  INT: math1(Math.trunc),
  MOD: (it, [a, b]) => {
    const x = it.num(a)
    const d = it.num(b)
    if (d === 0) return fail('#DIVIDE BY ZERO')
    return cleanNumber(x - d * Math.floor(x / d))
  },
  CEILING: (it, [a, b]) => {
    const x = it.num(a)
    const f = it.num(b)
    return f === 0 ? 0 : cleanNumber(Math.ceil(cleanNumber(x / f)) * f)
  },
  FLOOR: (it, [a, b]) => {
    const x = it.num(a)
    const f = it.num(b)
    return f === 0 ? 0 : cleanNumber(Math.floor(cleanNumber(x / f)) * f)
  },
  SQRT: (it, [a]) => {
    const x = it.num(a)
    return x < 0 ? fail('#INVALID VALUE', 'The square root of a negative number') : Math.sqrt(x)
  },
  POWER: (it, [a, b]) => {
    const r = Math.pow(it.num(a), it.num(b))
    return Number.isFinite(r) ? r : fail('#INVALID VALUE', 'The result is not a real number')
  },

  // ---- aggregates
  SUM: (it, args) => numbers(it, args).reduce((s, x) => s + x, 0),
  AVG: (it, args) => {
    const n = numbers(it, args)
    return n.length === 0 ? fail('#DIVIDE BY ZERO', 'There are no numbers to average') : n.reduce((s, x) => s + x, 0) / n.length
  },
  MIN: (it, args) => {
    const { nums, days } = extremes(it, args)
    if (days.length > 0) return mkDate(Math.min(...days))
    return nums.length === 0 ? 0 : Math.min(...nums)
  },
  MAX: (it, args) => {
    const { nums, days } = extremes(it, args)
    if (days.length > 0) return mkDate(Math.max(...days))
    return nums.length === 0 ? 0 : Math.max(...nums)
  },
  MEDIAN: (it, args) => {
    const n = numbers(it, args).sort((x, y) => x - y)
    if (n.length === 0) return fail('#INVALID VALUE', 'There are no numbers')
    const mid = n.length >> 1
    return n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2
  },
  COUNT: (it, args) => {
    let n = 0
    for (const a of args) for (const { v } of it.items(a)) if (!isBlank(v) && v !== '') n++
    return n
  },

  // ---- conditional
  COUNTIF: ifFamily('count', false),
  SUMIF: ifFamily('sum', false),
  AVERAGEIF: ifFamily('avg', false),
  COUNTIFS: ifFamily('count', true),
  SUMIFS: ifFamily('sum', true),
  AVERAGEIFS: ifFamily('avg', true),

  // ---- text
  LEFT: (it, [t, n]) => {
    const count = n ? it.int(n) : 1
    if (count < 0) return fail('#INVALID VALUE', 'The count cannot be negative')
    return it.text(t).slice(0, count)
  },
  RIGHT: (it, [t, n]) => {
    const s = it.text(t)
    const count = n ? it.int(n) : 1
    if (count < 0) return fail('#INVALID VALUE', 'The count cannot be negative')
    return count === 0 ? '' : s.slice(-count)
  },
  MID: (it, [t, st, n]) => {
    const start = it.int(st)
    const count = it.int(n)
    if (start < 1 || count < 0) return fail('#INVALID VALUE', 'The start must be at least 1 and the count not negative')
    return it.text(t).slice(start - 1, start - 1 + count)
  },
  LEN: (it, [t]) => it.text(t).length,
  UPPER: (it, [t]) => it.text(t).toUpperCase(),
  LOWER: (it, [t]) => it.text(t).toLowerCase(),
  TRIM: (it, [t]) => it.text(t).trim().replace(/ {2,}/g, ' '),
  CONCATENATE: (it, args) => args.map((a) => it.text(a)).join(''),
  SUBSTITUTE: (it, [t, o, n, inst]) => {
    const text = it.text(t)
    const old = it.text(o)
    const neu = it.text(n)
    if (old === '') return text
    if (!inst) return text.split(old).join(neu)
    const which = it.int(inst)
    if (which < 1) return fail('#INVALID VALUE', 'The instance must be at least 1')
    let at = -1
    for (let i = 0; i < which; i++) {
      at = text.indexOf(old, at + 1)
      if (at === -1) return text
    }
    return text.slice(0, at) + neu + text.slice(at + old.length)
  },
  REPLACE: (it, [t, st, n, w]) => {
    const text = it.text(t)
    const start = it.int(st)
    const count = it.int(n)
    if (start < 1 || count < 0) return fail('#INVALID VALUE', 'The start must be at least 1 and the count not negative')
    return text.slice(0, start - 1) + it.text(w) + text.slice(start - 1 + count)
  },
  FIND: (it, [s, t, st]) => {
    const start = st ? it.int(st) : 1
    if (start < 1) return fail('#INVALID VALUE', 'The start must be at least 1')
    return it.text(t).indexOf(it.text(s), start - 1) + 1
  },
  VALUE: (it, [a]) => {
    const v = it.scalar(a)
    if (typeof v === 'number') return v
    if (isBlank(v)) return 0
    if (typeof v === 'string' && isNumericText(v)) return Number(v)
    return fail('#INVALID VALUE', `${typeof v === 'string' ? `"${v}"` : 'This value'} is not a number`)
  },
  CHAR: (it, [a]) => {
    const n = it.int(a)
    return n >= 1 && n <= 65535 ? String.fromCharCode(n) : fail('#INVALID VALUE', 'The character code must be between 1 and 65535')
  },

  // ---- dates
  DATE: (it, [y, m, d]) => {
    const year = it.num(y)
    const month = it.num(m)
    const day = it.num(d)
    if (!Number.isInteger(month) || month < 1 || month > 12) return fail('#INVALID VALUE', 'The month must be 1 to 12')
    const r = ymdToDay(year, month, day)
    return r === null ? fail('#INVALID VALUE', 'Not a valid date') : mkDate(r)
  },
  TODAY: (it) => {
    const iso = it.ctx.today ?? new Date().toISOString().slice(0, 10)
    const d = isoToDay(iso)
    return d === null ? fail('#INVALID VALUE', 'today is not a date') : mkDate(d)
  },
  DAY: dateFn((d) => dayOfMonth(d)),
  MONTH: dateFn((d) => monthOf(d)),
  YEAR: dateFn((d) => yearOf(d)),
  WEEKDAY: dateFn((d) => weekdayOf(d) + 1),
  YEARDAY: dateFn((d) => dayOfYear(d)),
  DATEONLY: dateFn((d) => mkDate(d)),
  NETDAYS: (it, [a, b]) => {
    const x = it.day(a)
    const y = it.day(b)
    if (x === null || y === null) return BLANK
    return y >= x ? y - x + 1 : -(x - y + 1)
  },
  VARIANCE: (it, [a, b]) => {
    const x = it.day(a)
    const y = it.day(b)
    if (x === null || y === null) return BLANK
    return y - x
  },
  NETWORKDAYS: (it, [a, b, h]) => {
    const x = it.day(a)
    const y = it.day(b)
    if (x === null || y === null) return BLANK
    const n = countWorking(it, x, y, it.holidaySet(h))
    return y >= x ? n : -n
  },
  WORKDAY: (it, [a, n, h]) => {
    const from = it.day(a)
    const days = it.int(n)
    const holidays = it.holidaySet(h)
    if (from === null) return BLANK_DATE
    // Zero days returns the date itself, even on a weekend (observed).
    return checkedDate(days === 0 ? from : addWorking(it, from, days, holidays))
  },

  // ---- logic
  IF: (it, [c, yes, no]) => {
    if (it.bool(c)) return it.eval(yes)
    return no ? it.eval(no) : BLANK
  },
  IFERROR: (it, [v, fallback]) => {
    try {
      const r = it.eval(v)
      return r
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e
      return fallback ? it.eval(fallback) : BLANK
    }
  },
  AND: (it, args) => args.map((a) => it.bool(a)).every(Boolean),
  OR: (it, args) => args.map((a) => it.bool(a)).some(Boolean),
  NOT: (it, [a]) => !it.bool(a),
  ISBLANK: (it, [a]) => {
    const v = it.scalar(a)
    return isBlank(v) || v === ''
  },
  ISNUMBER: (it, [a]) => typeof it.scalar(a) === 'number',
  ISTEXT: (it, [a]) => {
    const v = it.scalar(a)
    return typeof v === 'string' && v !== ''
  },
  ISBOOLEAN: (it, [a]) => typeof it.scalar(a) === 'boolean',
  ISDATE: (it, [a]) => isDate(it.scalar(a)),
  ISERROR: (it, [a]) => {
    try {
      it.eval(a)
      return false
    } catch (e) {
      if (e instanceof FormulaError) return true
      throw e
    }
  },

  // ---- hierarchy
  CHILDREN: (it, args) => {
    const { col, row } = it.hierarchyTarget(args)
    return mkList(it.childRows(row).map((r) => it.readCell(col, r)))
  },
  DESCENDANTS: (it, args) => {
    const { col, row } = it.hierarchyTarget(args)
    return mkList(it.descendantRows(row).map((r) => it.readCell(col, r)))
  },
  ANCESTORS: (it, args) => {
    const { col, row } = it.hierarchyTarget(args)
    return mkList(it.ancestorRows(row).map((r) => it.readCell(col, r)))
  },
  PARENT: (it, args) => {
    const { col, row } = it.hierarchyTarget(args)
    const p = it.ctx.parent?.(row) ?? null
    return p === null ? BLANK : it.readCell(col, p)
  },

  // ---- lists
  JOIN: (it, [r, d]) => {
    const sep = d ? it.text(d) : ', '
    return it
      .list(r)
      .filter((v) => !isBlank(v) && v !== '')
      .map((v) => it.toText(v))
      .join(sep)
  },
  HAS: (it, [r, v]) => {
    const list = it.list(r)
    const needle = it.scalar(v)
    return list.some((x) => !isList(x) && it.compare('=', x, needle))
  },
  INDEX: (it, [r, n]) => {
    const list = it.list(r)
    const i = it.int(n)
    return i >= 1 && i <= list.length ? list[i - 1] : fail('#INVALID VALUE', 'The position is outside the range')
  },
  MATCH: (it, [v, r]) => {
    const needle = it.scalar(v)
    const list = it.list(r)
    return list.findIndex((x) => !isList(x) && it.compare('=', x, needle)) + 1
  },
  DISTINCT: (it, [r]) => {
    const out: Val[] = []
    for (const x of it.list(r)) if (!isBlank(x) && !out.some((y) => it.compare('=', x, y))) out.push(x)
    return mkList(out)
  },

  // ---- project functions (ours, derived from the scheduling engine; see docs/behavior/formulas.md)
  CALCDURATION: (it, [a, b]) => {
    const s = it.day(a)
    const e = it.day(b)
    if (s === null || e === null) return BLANK
    if (e < s) return fail('#INVALID VALUE', 'The end is before the start')
    return countWorking(it, s, e)
  },
  CALCSTART: (it, [d, e, h]) => {
    const end = it.day(e)
    const dur = it.num(d)
    const holidays = it.holidaySet(h)
    if (end === null) return BLANK_DATE
    if (dur < 0) return fail('#INVALID VALUE', 'The duration cannot be negative')
    let last = end
    while (!it.isWorking(last, holidays) && end - last < MAX_SPAN_DAYS) last--
    const days = Math.ceil(dur)
    return checkedDate(days <= 1 ? last : addWorking(it, last, -(days - 1), holidays))
  },
  CALCPERCENT: (it, [p, d]) => {
    const pct = it.list(p)
    const dur = it.list(d)
    if (pct.length !== dur.length) return fail('#INCORRECT ARGUMENT SET', 'Both lists must have the same size')
    if (pct.length === 0) return BLANK
    const nums = (list: Val[]) => list.map((v) => (typeof v === 'number' ? v : 0))
    const ps = nums(pct)
    const ds = nums(dur)
    const weight = ds.reduce((s, x) => s + x, 0)
    const value = weight > 0 ? ps.reduce((s, x, i) => s + x * ds[i], 0) / weight : ps.reduce((s, x) => s + x, 0) / ps.length
    return Math.round(value)
  },
}
