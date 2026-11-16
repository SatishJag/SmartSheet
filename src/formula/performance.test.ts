// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { defaultCalendar } from '../engine/calendar'
import type { Column } from '../model/validate'
import type { RowRecord, SheetData } from '../store/persistence'
import { evaluationCount, formulaEvaluator } from './sheetFormulas'

/**
 * Recalculation is dependency-aware: after an edit only the cells that (transitively) depend on the
 * edited cell are evaluated again, and a 5,000-row sheet stays fast. The numbers are logged so a
 * regression is visible in the test output; the assertions use generous bounds (CI machines vary) and
 * exact evaluation counts (which do not).
 */

const N = 5000

const columns: Column[] = [
  { id: 'task', title: 'Task', type: 'TEXT_NUMBER' },
  { id: 'qty', title: 'Qty', type: 'TEXT_NUMBER' },
  { id: 'rate', title: 'Rate', type: 'TEXT_NUMBER' },
  { id: 'total', title: 'Total', type: 'TEXT_NUMBER', formula: '=[Qty]*[Rate]' },
  { id: 'share', title: 'Share', type: 'TEXT_NUMBER', formula: '=[Total]/SUM(Total:Total)' },
  { id: 'level', title: 'Level', type: 'TEXT_NUMBER', formula: '=COUNT(ANCESTORS(Task@row))' },
]

const key = (i: number) => `a${String(i).padStart(6, '0')}`

let sheetNo = 0

/** A fresh sheet id each time: engines are kept per sheet id, and these tests count evaluations. */
function build(): SheetData {
  const rows: RowRecord[] = Array.from({ length: N }, (_, i) => ({
    id: `r${i}`,
    // every 50th row is a parent of the next 49 rows
    parentId: i % 50 === 0 ? null : `r${i - (i % 50)}`,
    position: key(i),
    cells: { task: `Task ${i}`, qty: (i % 7) + 1, rate: (i % 11) + 1 },
    version: 0,
  }))
  return { sheet: { id: `big-${++sheetNo}`, name: 'Big', ownerId: 'u', workspaceId: 'u', calendar: defaultCalendar, dependenciesEnabled: false }, columns, rows, dependencies: [] }
}

/** The next version of the sheet after one cell edit (as the store makes it: only that row is replaced). */
function edit(data: SheetData, rowId: string, colId: string, value: unknown): SheetData {
  return { ...data, rows: data.rows.map((r) => (r.id === rowId ? { ...r, cells: { ...r.cells, [colId]: value } } : r)) }
}

const time = <T,>(fn: () => T): [T, number] => {
  const t = performance.now()
  const r = fn()
  return [r, performance.now() - t]
}

describe('recalculation on a 5,000-row sheet', () => {
  it('evaluates every cell of a column formula quickly', () => {
    const data = build()
    const ev = formulaEvaluator(data)
    const [, ms] = time(() => {
      for (let i = 0; i < N; i++) ev(`r${i}`, 'total')
    })
    console.log(`[perf] ${N} cells of =[Qty]*[Rate]: ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(1500)
    expect(evaluationCount(data)).toBe(N)
    expect(ev('r13', 'total')).toMatchObject({ ok: true, value: ((13 % 7) + 1) * ((13 % 11) + 1) })
  })

  it('an edit re-evaluates only the cells that depend on it', () => {
    const v1 = build()
    const ev1 = formulaEvaluator(v1)
    for (let i = 0; i < N; i++) ev1(`r${i}`, 'total')
    expect(evaluationCount(v1)).toBe(N)

    const v2 = edit(v1, 'r10', 'qty', 100)
    const ev2 = formulaEvaluator(v2)
    const [, ms] = time(() => {
      for (let i = 0; i < N; i++) ev2(`r${i}`, 'total')
    })
    console.log(`[perf] one edit, all ${N} Total cells read again: ${ms.toFixed(1)} ms`)
    // Exactly one Total cell (r10) was evaluated again; the other 4,999 came from the cache.
    expect(evaluationCount(v2)).toBe(N + 1)
    expect(ev2('r10', 'total')).toMatchObject({ ok: true, value: 100 * ((10 % 11) + 1) })
    expect(ms).toBeLessThan(500)
  })

  it('a roll-up over a whole column is evaluated again only when that column changes', () => {
    const v1 = build()
    const ev1 = formulaEvaluator(v1)
    const [first, firstMs] = time(() => ev1('r0', 'share'))
    console.log(`[perf] first =[Total]/SUM(Total:Total) (evaluates all ${N} Totals): ${firstMs.toFixed(1)} ms`)
    expect(firstMs).toBeLessThan(2000)
    const before = evaluationCount(v1)
    expect(before).toBe(N + 1) // the 5,000 Totals and this Share

    // An edit that changes no Total (Task text): nothing is evaluated again.
    const v2 = edit(v1, 'r5', 'task', 'renamed')
    const second = formulaEvaluator(v2)('r0', 'share')
    expect(second).toEqual(first)
    expect(evaluationCount(v2)).toBe(before)

    // An edit to Qty changes one Total, which the Share of every row reads: those are evaluated again, lazily.
    const v3 = edit(v2, 'r7', 'qty', 50)
    const ev3 = formulaEvaluator(v3)
    const [, ms] = time(() => ev3('r0', 'share'))
    console.log(`[perf] after a Qty edit, one Share cell again: ${ms.toFixed(1)} ms`)
    expect(evaluationCount(v3)).toBe(before + 2) // Total of r7 and Share of r0
    expect(ms).toBeLessThan(200)
    expect(ev3('r0', 'share')).not.toEqual(first)
  })

  it('hierarchy roll-ups (ANCESTORS) over 5,000 rows', () => {
    const data = build()
    const ev = formulaEvaluator(data)
    const [, ms] = time(() => {
      for (let i = 0; i < N; i++) ev(`r${i}`, 'level')
    })
    console.log(`[perf] ${N} cells of =COUNT(ANCESTORS(Task@row)): ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(1500)
    expect(ev('r0', 'level')).toMatchObject({ value: 0 })
    expect(ev('r49', 'level')).toMatchObject({ value: 1 })
  })

  it('a long dependency chain is evaluated without recursion trouble and invalidated end to end', () => {
    const cols: Column[] = [
      { id: 'task', title: 'Task', type: 'TEXT_NUMBER' },
      { id: 'v', title: 'V', type: 'TEXT_NUMBER' },
    ]
    // V of row i = V of row i-1 + 1 (a chain 300 deep through [V]N references)
    const rows: RowRecord[] = Array.from({ length: 300 }, (_, i) => ({
      id: `c${i}`,
      parentId: null,
      position: key(i),
      cells: { task: `T${i}`, v: i === 0 ? 1 : `=[V]${i}+1` },
      version: 0,
    }))
    const base: SheetData = { sheet: { id: 'chain', name: 'C', ownerId: 'u', workspaceId: 'u', calendar: defaultCalendar, dependenciesEnabled: false }, columns: cols, rows, dependencies: [] }
    expect(formulaEvaluator(base)('c299', 'v')).toMatchObject({ ok: true, value: 300 })
    const next = edit(base, 'c0', 'v', 1000)
    expect(formulaEvaluator(next)('c299', 'v')).toMatchObject({ ok: true, value: 1299 })
  })
})
