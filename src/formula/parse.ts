/**
 * Formula parser: a hand-written scanner + recursive descent (no eval, no Function). Pure.
 * Anything it cannot read is `#UNPARSEABLE`; calls with the wrong argument count are
 * `#INCORRECT ARGUMENT SET`; array literals and {cross-sheet} references parse and then fail
 * with `#INVALID REF` when evaluated (docs/behavior/formulas.md).
 */
import { functionInfo } from './registry'
import { FormulaError, fail } from './values'

export type RefMode =
  /** `[Col]` on its own: this row's cell, or the whole column when it is a direct argument of SUM, COUNT, ... */
  | 'bare'
  /** `Col@row` / `[Col]@row` */
  | 'same'
  /** `[Col]5`: a specific row (1-based, in sheet order) */
  | 'row'
  /** `Col:Col`, `[Col]:[Col]` (whole column) or `[Col]2:[Col]9` (rows 2 to 9) */
  | 'range'

export interface RefNode {
  k: 'ref'
  col: string
  mode: RefMode
  row?: number
  /** Range end column (must name the same column) and the optional row bounds. */
  col2?: string
  row2?: number
}

export type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | RefNode
  /** `{...}`: an array literal or a cross-sheet reference; not supported, `#INVALID REF` when evaluated. */
  | { k: 'bad'; text: string }
  | { k: 'neg'; e: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'call'; name: string; args: Node[] }

/** Deepest nesting (parentheses, calls, unary minus) a formula may use. */
const MAX_DEPTH = 100

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'
const isIdentStart = (c: string | undefined): boolean => c !== undefined && (/[A-Za-z_]/.test(c) || c > '\u007f')
const isIdentPart = (c: string | undefined): boolean => isDigit(c) || isIdentStart(c)

class Parser {
  private i = 0
  private depth = 0
  constructor(private readonly s: string) {}

  private unparseable(detail: string): never {
    return fail('#UNPARSEABLE', detail)
  }

  private nested<T>(parse: () => T): T {
    if (++this.depth > MAX_DEPTH) this.unparseable('Formula is nested too deeply')
    try {
      return parse()
    } finally {
      this.depth--
    }
  }

  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++
  }

  private peek(): string | undefined {
    this.ws()
    return this.s[this.i]
  }

  private eat(text: string): boolean {
    this.ws()
    if (this.s.startsWith(text, this.i)) {
      this.i += text.length
      return true
    }
    return false
  }

  private near(): string {
    const c = this.s[this.i]
    return c === undefined ? 'end of formula' : `'${c}'`
  }

  parse(): Node {
    const node = this.comparison()
    this.ws()
    if (this.i < this.s.length) this.unparseable(`Unexpected ${this.near()}`)
    return node
  }

  private comparison(): Node {
    let left = this.additive()
    for (;;) {
      this.ws()
      const op = ['<>', '<=', '>=', '<', '>', '='].find((o) => this.s.startsWith(o, this.i))
      if (!op) return left
      this.i += op.length
      left = { k: 'bin', op, l: left, r: this.additive() }
    }
  }

  private additive(): Node {
    let left = this.multiplicative()
    for (;;) {
      const c = this.peek()
      if (c !== '+' && c !== '-') return left
      this.i++
      left = { k: 'bin', op: c, l: left, r: this.multiplicative() }
    }
  }

  private multiplicative(): Node {
    let left = this.power()
    for (;;) {
      const c = this.peek()
      if (c !== '*' && c !== '/') return left
      this.i++
      left = { k: 'bin', op: c, l: left, r: this.power() }
    }
  }

  /** `^` binds tighter than * and / but looser than unary minus, left to right (as in Excel). */
  private power(): Node {
    let left = this.unary()
    while (this.peek() === '^') {
      this.i++
      left = { k: 'bin', op: '^', l: left, r: this.unary() }
    }
    return left
  }

  private unary(): Node {
    const c = this.peek()
    if (c === '-') {
      this.i++
      return { k: 'neg', e: this.nested(() => this.unary()) }
    }
    if (c === '+') {
      this.i++
      return this.nested(() => this.unary())
    }
    return this.primary()
  }

  private primary(): Node {
    const c = this.peek()
    if (c === undefined) return this.unparseable('Unexpected end of formula')
    if (isDigit(c) || (c === '.' && isDigit(this.s[this.i + 1]))) return this.number()
    if (c === '"') return this.string()
    if (c === '(') {
      this.i++
      const inner = this.nested(() => this.comparison())
      if (!this.eat(')')) this.unparseable("Expected ')'")
      return inner
    }
    if (c === '{') {
      const end = this.s.indexOf('}', this.i)
      if (end === -1) this.unparseable("Missing closing '}'")
      const text = this.s.slice(this.i, end + 1)
      this.i = end + 1
      return { k: 'bad', text }
    }
    if (c === '[') return this.reference(this.bracket())
    if (isIdentStart(c)) return this.identifier()
    return this.unparseable(`Unexpected '${c}'`)
  }

  private number(): Node {
    const m = /^(\d+\.?\d*|\.\d+)/.exec(this.s.slice(this.i))!
    this.i += m[0].length
    return { k: 'num', v: Number(m[0]) }
  }

  private string(): Node {
    let out = ''
    this.i++ // opening quote
    for (;;) {
      const c = this.s[this.i]
      if (c === undefined) return this.unparseable('Unterminated string literal (missing closing ")')
      this.i++
      if (c === '"') return { k: 'str', v: out }
      if (c === '\\' && (this.s[this.i] === '"' || this.s[this.i] === '\\')) {
        out += this.s[this.i++]
      } else out += c
    }
  }

  private bracket(): string {
    const end = this.s.indexOf(']', this.i)
    if (end === -1) this.unparseable('Unterminated column reference (missing closing ])')
    const title = this.s.slice(this.i + 1, end).trim()
    if (title === '') this.unparseable('Empty column reference []')
    this.i = end + 1
    return title
  }

  private ident(): string {
    const start = this.i
    while (isIdentPart(this.s[this.i])) this.i++
    return this.s.slice(start, this.i)
  }

  private identifier(): Node {
    const name = this.ident()
    // A function call: NAME followed by (
    const save = this.i
    if (this.peek() === '(') {
      this.i++
      return this.call(name)
    }
    this.i = save
    if (this.s.startsWith('@row', this.i) || this.s[this.i] === ':') return this.reference(name)
    const upper = name.toUpperCase()
    if (upper === 'TRUE') return { k: 'bool', v: true }
    if (upper === 'FALSE') return { k: 'bool', v: false }
    return this.unparseable(`Unexpected name '${name}'`)
  }

  /** The suffix after a column head (a bare name or a [bracketed title]): @row, a row number, :range. */
  private reference(col: string): Node {
    const bracketed = this.s[this.i - 1] === ']'
    let mode: RefMode = 'bare'
    let row: number | undefined
    if (/^@row(?![A-Za-z0-9_])/i.test(this.s.slice(this.i))) {
      this.i += 4
      mode = 'same'
    } else if (bracketed && isDigit(this.s[this.i])) {
      row = this.rowNumber()
      mode = 'row'
    }
    if (this.s[this.i] === ':' && mode !== 'same') {
      this.i++
      const c = this.s[this.i]
      let col2: string
      if (c === '[') col2 = this.bracket()
      else if (isIdentStart(c)) col2 = this.ident()
      else return this.unparseable("Expected a column after ':'")
      let row2: number | undefined
      if (this.s[this.i - 1] === ']' && isDigit(this.s[this.i])) row2 = this.rowNumber()
      if ((row === undefined) !== (row2 === undefined)) this.unparseable('A row range names the rows on both sides: [Col]2:[Col]9')
      return { k: 'ref', col, mode: 'range', col2, ...(row !== undefined ? { row, row2 } : {}) }
    }
    if (mode === 'bare' && !bracketed) return this.unparseable(`Unexpected name '${col}'`)
    return { k: 'ref', col, mode, ...(row !== undefined ? { row } : {}) }
  }

  private rowNumber(): number {
    const start = this.i
    while (isDigit(this.s[this.i])) this.i++
    return Number(this.s.slice(start, this.i))
  }

  private call(rawName: string): Node {
    const name = rawName.toUpperCase()
    const info = functionInfo(name)
    if (!info) this.unparseable(`Unknown function '${rawName}'`)
    const args: Node[] = []
    if (!this.eat(')')) {
      for (;;) {
        args.push(this.nested(() => this.comparison()))
        if (this.eat(',')) continue
        if (this.eat(')')) break
        this.unparseable(`Expected ',' or ')' but found ${this.near()}`)
      }
    }
    if (args.length < info.min || args.length > info.max) {
      const want = info.min === info.max ? `${info.min}` : info.max === Infinity ? `at least ${info.min}` : `${info.min} to ${info.max}`
      fail('#INCORRECT ARGUMENT SET', `${info.name} expects ${want} argument${want === '1' ? '' : 's'} but got ${args.length}`)
    }
    return { k: 'call', name, args }
  }
}

const cache = new Map<string, Node | FormulaError>()
const CACHE_LIMIT = 4000

/**
 * Parses the text after the leading `=`. Cached by text (a column formula is parsed once, not once
 * per row); a parse failure is cached too and rethrown.
 */
export function parseFormula(src: string): Node {
  const hit = cache.get(src)
  if (hit) {
    if (hit instanceof FormulaError) throw hit
    return hit
  }
  let result: Node | FormulaError
  try {
    result = new Parser(src).parse()
  } catch (e) {
    result = e instanceof FormulaError ? e : new FormulaError('#UNPARSEABLE', e instanceof Error ? e.message : String(e))
  }
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(src, result)
  if (result instanceof FormulaError) throw result
  return result
}
