// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { defaultCalendar } from '../engine/calendar'
import type { Column, ColumnType } from '../model/validate'
import type { RowRecord, SheetData } from '../store/persistence'
import { formatFormulaValue, formulaEvaluator, type FormulaCellResult } from './sheetFormulas'

/**
 * Conformance of our formula engine with the observed behaviour of the reference product
 * (docs/behavior/formulas.md). Every vector in docs/behavior/vectors/formulas-*.json is evaluated
 * through the real sheet evaluator (a formula cell in a column of the stated type) and compared
 * with the recorded result. Differences we have chosen to keep are listed, with the reason, in
 * `knownDifferences`; each one still asserts what WE return, so the list cannot silently drift.
 */

const VECTORS = resolve(__dirname, '../../docs/behavior/vectors')
const load = <T,>(name: string): T => JSON.parse(readFileSync(resolve(VECTORS, name), 'utf8')) as T

/** The day the vectors were recorded (TODAY() results depend on it). */
const OBSERVED_TODAY = '2026-11-16'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${OBSERVED_TODAY}T12:00:00Z`))
})
afterAll(() => {
  vi.useRealTimers()
})

interface KnownDifference {
  /** `file#expr` or, for the hierarchy file, `file#expr#row`; the typed file adds `#T|B|D`. */
  key: string
  reason: string
  /** What our engine returns for it (asserted, so the entry cannot go stale). */
  ours: Expected
}

type Expected = number | string | boolean | null

const WILDCARD_REASON =
  'The reference matched nothing for a wildcard criterion in the observation, and its documentation is unclear; ours supports * and ? (extension).'
const MULTI_RANGE_REASON =
  'The reference answered #INCORRECT ARGUMENT SET when the sum range / second range was a whole column; the notes ask to re-check with explicit row ranges. Ours implements them (extension, flagged as ours).'
const EXTENSION_REASON =
  'The reference has no such function (#UNPARSEABLE). Ours is a clearly marked extension (registry entry `ours: true`, docs/behavior/formulas.md).'
const CYCLE_REASON =
  'Which members of a dependency cycle the reference reports as #BLOCKED rather than #CIRCULAR REFERENCE depends on its evaluation order. Ours reports #CIRCULAR REFERENCE for every cell that lies on the cycle and #BLOCKED only for cells that merely depend on one.'

const knownDifferences: KnownDifference[] = [
  { key: 'text#=COUNTIF(Txt:Txt,"a*")', reason: WILDCARD_REASON, ours: 1 },
  { key: 'text#=SUMIF(Num:Num,">1",Num2:Num2)', reason: MULTI_RANGE_REASON, ours: 11 },
  { key: 'text#=COUNTIFS(Num:Num,">0",Num2:Num2,">0")', reason: MULTI_RANGE_REASON, ours: 3 },
  { key: 'text#=SUMIFS(Num:Num,Num2:Num2,">0")', reason: MULTI_RANGE_REASON, ours: 6 },
  { key: 'text#=SQRT(16)', reason: EXTENSION_REASON, ours: 4 },
  { key: 'text#=SQRT(-1)', reason: EXTENSION_REASON, ours: '#INVALID VALUE' },
  { key: 'text#=POWER(2,8)', reason: EXTENSION_REASON, ours: 256 },
  { key: 'text#=TRIM("  a  b ")', reason: EXTENSION_REASON, ours: 'a b' },
  { key: 'text#=CONCATENATE("a","b",1)', reason: EXTENSION_REASON, ours: 'ab1' },
  { key: 'hier#=SUM(CHILDREN()) + SUM(PARENT())#c1', reason: CYCLE_REASON, ours: '#CIRCULAR REFERENCE' },
  { key: 'hier#=SUM(CHILDREN()) + SUM(PARENT())#c2', reason: CYCLE_REASON, ours: '#CIRCULAR REFERENCE' },
]
const known = new Map(knownDifferences.map((k) => [k.key, k]))
const usedKnown = new Set<string>()

/** What a formula cell holds, in the comparable form the vectors use: a value, null for blank, or an error name. */
function observed(r: FormulaCellResult | null): Expected {
  if (!r) throw new Error('not a formula cell')
  if (!r.ok) return r.error
  return r.value
}

function check(key: string, got: Expected, want: Expected): void {
  const diff = known.get(key)
  if (diff) {
    usedKnown.add(key)
    expect(got, `known difference ${key}: ${diff.reason}`).toEqual(diff.ours)
    expect(got, `${key} is listed as a known difference but now matches the reference`).not.toEqual(want)
  } else {
    expect(got, key).toEqual(want)
  }
}

const row = (id: string, position: string, cells: Record<string, unknown>, parentId: string | null = null): RowRecord => ({
  id,
  parentId,
  position,
  cells,
  version: 0,
})

function sheet(columns: Column[], rows: RowRecord[]): SheetData {
  return {
    sheet: { id: 's', name: 'S', ownerId: 'u', workspaceId: 'u', calendar: defaultCalendar, dependenciesEnabled: false },
    columns,
    rows,
    dependencies: [],
  }
}

const col = (id: string, type: ColumnType = 'TEXT_NUMBER'): Column => ({ id, title: id, type })

interface TextVector {
  expr: string
  value: Expected
  display: string | null
}

describe('formulas-text-column.json (destination: text/number column)', () => {
  const vectors = load<TextVector[]>('formulas-text-column.json')
  // Rows 1-3 hold data; the formula under test sits in row 4 whose other cells are blank.
  const columns = [col('Task'), col('Num'), col('Num2'), col('Txt'), col('Chk', 'CHECKBOX'), col('Dt', 'DATE'), col('Dt2', 'DATE'), col('Out')]
  const data = (formula: string) =>
    sheet(columns, [
      row('r1', 'a0', { Num: 1, Num2: 4, Txt: 'apple' }),
      row('r2', 'a1', { Num: 2, Num2: 5, Txt: 'pear' }),
      row('r3', 'a2', { Num: 3, Num2: 6, Txt: 'plum' }),
      row('r4', 'a3', { Out: formula }),
    ])

  it.each(vectors.map((v) => [v.expr, v] as const))('%s', (_expr, v) => {
    const ev = formulaEvaluator(data(v.expr))
    const r = ev('r4', 'Out')
    check(`text#${v.expr}`, observed(r), v.value)
    if (!known.has(`text#${v.expr}`)) {
      const display = r!.ok ? formatFormulaValue(r!.value) : r!.error
      expect(display, `display of ${v.expr}`).toBe(v.display ?? '')
    }
  })
})

interface TypedVector {
  expr: string
  T: { v: Expected }
  B: { v: Expected }
  D: { v: Expected }
}

describe('formulas-typed-columns.json (destination: text, checkbox, date)', () => {
  const vectors = load<TypedVector[]>('formulas-typed-columns.json')
  // One data row with every cell blank: Num, Txt, Chk, Dt. (No Dt2 column: references to it are unparseable.)
  const columns = [col('Task'), col('Num'), col('Txt'), col('Chk', 'CHECKBOX'), col('Dt', 'DATE'), col('T'), col('B', 'CHECKBOX'), col('D', 'DATE')]
  const cases = vectors.flatMap((v) => (['T', 'B', 'D'] as const).map((dest) => [`${v.expr} -> ${dest}`, v, dest] as const))

  it.each(cases)('%s', (_name, v, dest) => {
    const data = sheet(columns, [row('r1', 'a0', { [dest]: v.expr })])
    const r = formulaEvaluator(data)('r1', dest)
    check(`typed#${v.expr}#${dest}`, observed(r), v[dest].v)
  })
})

interface HierVector {
  expr: string
  by_row: Record<string, string | null>
}

describe('formulas-hierarchy.json', () => {
  const vectors = load<HierVector[]>('formulas-hierarchy.json')
  // P1(c1=10, c2=20, c3=30), P2(d1=5(g1=7), d2=8), solo=99; the formula is the column formula of F.
  const num = { c1: 10, c2: 20, c3: 30, d1: 5, g1: 7, d2: 8, solo: 99 } as Record<string, number>
  const tree: [string, string | null][] = [
    ['P1', null],
    ['c1', 'P1'],
    ['c2', 'P1'],
    ['c3', 'P1'],
    ['P2', null],
    ['d1', 'P2'],
    ['g1', 'd1'],
    ['d2', 'P2'],
    ['solo', null],
  ]
  const rows = tree.map(([name, parent], i) =>
    row(name, `a${i}`, { Task: name, ...(name in num ? { Num: num[name] } : {}) }, parent),
  )
  // Sibling positions must restart per parent, tree order is what matters.
  const positions: Record<string, string> = { P1: 'a0', c1: 'a0', c2: 'a1', c3: 'a2', P2: 'a1', d1: 'a0', g1: 'a0', d2: 'a1', solo: 'a2' }
  for (const r of rows) r.position = positions[r.id]
  const columns: Column[] = [col('Task'), col('Num'), col('F')]

  it.each(vectors.map((v) => [v.expr, v] as const))('%s', (_expr, v) => {
    const data = sheet(
      columns.map((c) => (c.id === 'F' ? { ...c, formula: v.expr } : c)),
      rows,
    )
    const ev = formulaEvaluator(data)
    for (const [name, want] of Object.entries(v.by_row)) {
      const r = ev(name, 'F')
      const got = r === null ? null : r.ok ? (r.value === null ? null : formatFormulaValue(r.value)) : r.error
      check(`hier#${v.expr}#${name}`, got, want)
    }
  })
})

describe('known differences', () => {
  it('every entry was exercised (no stale keys)', () => {
    expect([...known.keys()].filter((k) => !usedKnown.has(k))).toEqual([])
  })
})
