/**
 * Formula evaluator: tokenizer + recursive-descent parser + AST interpreter.
 * Pure and dependency-free. Never uses eval/new Function and never throws.
 */

export interface FormulaContext {
  cell(colTitle: string, rowIndex: number): unknown
  rowIndex: number
  rowCount: number
  hasColumn(title: string): boolean
  /** ISO YYYY-MM-DD used by TODAY(). Defaults to the real current UTC date. */
  today?: string
}

export type FormulaValue = number | string | boolean

export type FormulaResult =
  | { ok: true; value: FormulaValue }
  | { ok: false; error: string }

class FormulaError extends Error {}

function fail(message: string): never {
  throw new FormulaError(message)
}

// ---------------------------------------------------------------- tokenizer

type Token =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'column'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: string }
  | { type: 'eof' }

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9'
}

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
    } else if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      let j = i
      while (j < src.length && isDigit(src[j])) j++
      if (src[j] === '.') {
        j++
        while (j < src.length && isDigit(src[j])) j++
      }
      tokens.push({ type: 'number', value: Number(src.slice(i, j)) })
      i = j
    } else if (c === '"') {
      const end = src.indexOf('"', i + 1)
      if (end === -1) fail('Unterminated string literal (missing closing ")')
      tokens.push({ type: 'string', value: src.slice(i + 1, end) })
      i = end + 1
    } else if (c === '[') {
      const end = src.indexOf(']', i + 1)
      if (end === -1) fail('Unterminated column reference (missing closing ])')
      const title = src.slice(i + 1, end).trim()
      if (title === '') fail('Empty column reference []')
      tokens.push({ type: 'column', value: title })
      i = end + 1
    } else if (isIdentStart(c)) {
      let j = i + 1
      while (j < src.length && (isIdentStart(src[j]) || isDigit(src[j]))) j++
      tokens.push({ type: 'ident', value: src.slice(i, j) })
      i = j
    } else if (c === '<' || c === '>') {
      const next = src[i + 1]
      if (next === '=' || (c === '<' && next === '>')) {
        tokens.push({ type: 'op', value: c + next })
        i += 2
      } else {
        tokens.push({ type: 'op', value: c })
        i++
      }
    } else if ('+-*/=(),'.includes(c)) {
      tokens.push({ type: 'op', value: c })
      i++
    } else {
      fail(`Unexpected character '${c}'`)
    }
  }
  tokens.push({ type: 'eof' })
  return tokens
}

// ------------------------------------------------------------------- parser

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'col'; title: string }
  | { kind: 'neg'; operand: Node }
  | { kind: 'bin'; op: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] }

function describe(t: Token): string {
  switch (t.type) {
    case 'eof':
      return 'end of formula'
    case 'string':
      return `string "${t.value}"`
    case 'column':
      return `column [${t.value}]`
    case 'number':
      return `number ${t.value}`
    default:
      return `'${t.value}'`
  }
}

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.comparison()
    const t = this.peek()
    if (t.type !== 'eof') fail(`Unexpected ${describe(t)}`)
    return node
  }

  private peek(): Token {
    return this.tokens[this.pos]
  }

  private next(): Token {
    return this.tokens[this.pos++]
  }

  private isOp(...ops: string[]): boolean {
    const t = this.peek()
    return t.type === 'op' && ops.includes(t.value)
  }

  private expectOp(op: string): void {
    const t = this.next()
    if (t.type !== 'op' || t.value !== op) {
      fail(`Expected '${op}' but found ${describe(t)}`)
    }
  }

  private comparison(): Node {
    let left = this.additive()
    while (this.isOp('<', '>', '<=', '>=', '=', '<>')) {
      const op = (this.next() as { value: string }).value
      left = { kind: 'bin', op, left, right: this.additive() }
    }
    return left
  }

  private additive(): Node {
    let left = this.multiplicative()
    while (this.isOp('+', '-')) {
      const op = (this.next() as { value: string }).value
      left = { kind: 'bin', op, left, right: this.multiplicative() }
    }
    return left
  }

  private multiplicative(): Node {
    let left = this.unary()
    while (this.isOp('*', '/')) {
      const op = (this.next() as { value: string }).value
      left = { kind: 'bin', op, left, right: this.unary() }
    }
    return left
  }

  private unary(): Node {
    if (this.isOp('-')) {
      this.next()
      return { kind: 'neg', operand: this.unary() }
    }
    return this.primary()
  }

  private primary(): Node {
    const t = this.next()
    switch (t.type) {
      case 'number':
        return { kind: 'num', value: t.value }
      case 'string':
        return { kind: 'str', value: t.value }
      case 'column':
        return { kind: 'col', title: t.value }
      case 'ident': {
        if (this.isOp('(')) {
          this.next()
          const args: Node[] = []
          if (this.isOp(')')) {
            this.next()
          } else {
            args.push(this.comparison())
            while (this.isOp(',')) {
              this.next()
              args.push(this.comparison())
            }
            this.expectOp(')')
          }
          return { kind: 'call', name: t.value.toUpperCase(), args }
        }
        const upper = t.value.toUpperCase()
        if (upper === 'TRUE') return { kind: 'bool', value: true }
        if (upper === 'FALSE') return { kind: 'bool', value: false }
        return fail(`Unexpected name '${t.value}'`)
      }
      case 'op':
        if (t.value === '(') {
          const inner = this.comparison()
          this.expectOp(')')
          return inner
        }
        return fail(`Unexpected ${describe(t)}`)
      default:
        return fail(`Unexpected ${describe(t)}`)
    }
  }
}

// -------------------------------------------------------------- interpreter

function normalizeCell(raw: unknown): FormulaValue {
  if (raw === undefined || raw === null) return ''
  if (typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean') {
    return raw
  }
  return String(raw)
}

/** Strict numeric coercion: '' -> 0, numeric strings -> number, otherwise null. */
function tryNumber(v: FormulaValue): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const s = v.trim()
    if (s === '') return 0
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function toNumber(v: FormulaValue): number {
  const n = tryNumber(v)
  if (n === null) {
    fail(`Expected a number but got ${typeof v === 'string' ? `"${v}"` : String(v)}`)
  }
  return n
}

function checkFinite(n: number): number {
  if (!Number.isFinite(n)) fail('Result is not a finite number')
  return n
}

function compare(op: string, a: FormulaValue, b: FormulaValue): boolean {
  let result: number | null
  if (typeof a === 'string' && typeof b === 'string') {
    result = a < b ? -1 : a > b ? 1 : 0
  } else if (typeof a === 'boolean' && typeof b === 'boolean') {
    result = Number(a) - Number(b)
  } else {
    const na = tryNumber(a)
    const nb = tryNumber(b)
    result = na === null || nb === null ? null : na < nb ? -1 : na > nb ? 1 : 0
  }
  if (result === null) {
    if (op === '=') return false
    if (op === '<>') return true
    fail('Cannot compare values of different types')
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

function parseIsoDate(value: FormulaValue): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`Invalid date ${JSON.stringify(value)}; expected YYYY-MM-DD`)
  }
  const y = Number(value.slice(0, 4))
  const m = Number(value.slice(5, 7))
  const d = Number(value.slice(8, 10))
  const date = new Date(0)
  date.setUTCFullYear(y, m - 1, d)
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    fail(`Invalid date ${JSON.stringify(value)}; no such calendar day`)
  }
  return Math.round(date.getTime() / 86_400_000)
}

/** Mon-Fri days strictly after day d1 up to and including d2 (day numbers since epoch). */
function weekdaysBetween(d1: number, d2: number): number {
  if (d2 < d1) return -weekdaysBetween(d2, d1)
  const span = d2 - d1
  const fullWeeks = Math.floor(span / 7)
  let count = fullWeeks * 5
  for (let day = d1 + fullWeeks * 7 + 1; day <= d2; day++) {
    // Epoch day 0 (1970-01-01) was a Thursday (4).
    const weekday = (((day + 4) % 7) + 7) % 7
    if (weekday >= 1 && weekday <= 5) count++
  }
  return count
}

function currentUtcDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function expectArgs(name: string, args: Node[], count: number): void {
  if (args.length !== count) {
    fail(`${name} expects ${count} argument${count === 1 ? '' : 's'} but got ${args.length}`)
  }
}

function readColumn(title: string, ctx: FormulaContext, rowIndex: number): FormulaValue {
  if (!ctx.hasColumn(title)) fail(`Unknown column '${title}'`)
  return normalizeCell(ctx.cell(title, rowIndex))
}

function evalNode(node: Node, ctx: FormulaContext): FormulaValue {
  switch (node.kind) {
    case 'num':
    case 'str':
    case 'bool':
      return node.value
    case 'col':
      return readColumn(node.title, ctx, ctx.rowIndex)
    case 'neg':
      return -toNumber(evalNode(node.operand, ctx)) || 0
    case 'bin': {
      const a = evalNode(node.left, ctx)
      const b = evalNode(node.right, ctx)
      switch (node.op) {
        case '+':
          return checkFinite(toNumber(a) + toNumber(b))
        case '-':
          return checkFinite(toNumber(a) - toNumber(b))
        case '*':
          return checkFinite(toNumber(a) * toNumber(b))
        case '/': {
          const divisor = toNumber(b)
          if (divisor === 0) fail('Division by zero')
          return checkFinite(toNumber(a) / divisor)
        }
        default:
          return compare(node.op, a, b)
      }
    }
    case 'call':
      return callFunction(node.name, node.args, ctx)
  }
}

function callFunction(name: string, args: Node[], ctx: FormulaContext): FormulaValue {
  switch (name) {
    case 'SUM': {
      let total = 0
      for (const arg of args) {
        if (arg.kind === 'col') {
          if (!ctx.hasColumn(arg.title)) fail(`Unknown column '${arg.title}'`)
          for (let row = 0; row < ctx.rowCount; row++) {
            const v = normalizeCell(ctx.cell(arg.title, row))
            if (typeof v === 'boolean' || (typeof v === 'string' && v.trim() === '')) continue
            const n = tryNumber(v)
            if (n !== null) total += n
          }
        } else {
          total += toNumber(evalNode(arg, ctx))
        }
      }
      return checkFinite(total)
    }
    case 'IF': {
      expectArgs('IF', args, 3)
      const cond = evalNode(args[0], ctx)
      if (typeof cond !== 'boolean') fail('IF condition must be a boolean (true/false) value')
      return evalNode(cond ? args[1] : args[2], ctx)
    }
    case 'TODAY':
      expectArgs('TODAY', args, 0)
      return ctx.today ?? currentUtcDate()
    case 'NETDAYS': {
      expectArgs('NETDAYS', args, 2)
      const d1 = parseIsoDate(evalNode(args[0], ctx))
      const d2 = parseIsoDate(evalNode(args[1], ctx))
      return weekdaysBetween(d1, d2)
    }
    default:
      return fail(`Unknown function '${name}'`)
  }
}

// ------------------------------------------------------------------- public

export function evaluate(formula: string, ctx: FormulaContext): FormulaResult {
  try {
    if (typeof formula !== 'string' || !formula.trimStart().startsWith('=')) {
      return { ok: false, error: "Formula must start with '='" }
    }
    const src = formula.trimStart().slice(1)
    const ast = new Parser(tokenize(src)).parse()
    return { ok: true, value: evalNode(ast, ctx) }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message }
  }
}
