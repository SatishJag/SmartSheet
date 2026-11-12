import { describe, expect, it } from 'vitest'
import { defaultCalendar } from '../engine/calendar'
import type { Column } from '../model/validate'
import type { RowRecord, SheetData } from '../store/persistence'
import { formatFormulaValue, formulaEvaluator, isFormula } from './sheetFormulas'

const columns: Column[] = [
  { id: 'task', title: 'Task', type: 'TEXT_NUMBER' },
  { id: 'qty', title: 'Qty', type: 'TEXT_NUMBER' },
  { id: 'cost', title: 'Cost', type: 'TEXT_NUMBER' },
  { id: 'calc', title: 'Calc', type: 'TEXT_NUMBER' },
  { id: 'start', title: 'Start', type: 'DATE', role: 'start' },
]

const row = (id: string, position: string, cells: Record<string, unknown>, parentId: string | null = null): RowRecord => ({
  id,
  parentId,
  position,
  cells,
  version: 0,
})

function sheet(rows: RowRecord[]): SheetData {
  return {
    sheet: { id: 's', name: 'S', ownerId: 'u', workspaceId: 'u', calendar: defaultCalendar, dependenciesEnabled: true },
    columns,
    rows,
    dependencies: [],
  }
}

describe('isFormula / formatFormulaValue', () => {
  it('detects formulas and formats values', () => {
    expect(isFormula('=1+2')).toBe(true)
    expect(isFormula('1+2')).toBe(false)
    expect(isFormula(3)).toBe(false)
    expect(formatFormulaValue(3)).toBe('3')
    expect(formatFormulaValue(0.1 + 0.2)).toBe('0.3')
    expect(formatFormulaValue(true)).toBe('TRUE')
    expect(formatFormulaValue(false)).toBe('FALSE')
    expect(formatFormulaValue('big')).toBe('big')
  })
})

describe('formulaEvaluator', () => {
  it('evaluates arithmetic, SUM over a column (in full tree order) and IF on the same row', () => {
    const data = sheet([
      row('r1', 'a0', { qty: 3, cost: 10, calc: '=1+2' }),
      row('r2', 'a1', { qty: 1, cost: '5', calc: '=SUM([Cost])' }),
      row('r3', 'a2', { qty: 5, cost: 2, calc: '=IF([Qty]>2,"big","small")' }),
      row('r0', 'a0', { qty: 1, cost: 1, calc: '=IF([Qty]>2,"big","small")' }, 'r1'), // child of r1: row 2
    ])
    const ev = formulaEvaluator(data)
    expect(ev('r1', 'calc')).toEqual({ ok: true, value: 3 })
    expect(ev('r2', 'calc')).toEqual({ ok: true, value: 18 })
    expect(ev('r3', 'calc')).toEqual({ ok: true, value: 'big' })
    expect(ev('r0', 'calc')).toEqual({ ok: true, value: 'small' })
    expect(ev('r1', 'qty')).toBeNull() // not a formula
  })

  it('uses evaluated values of referenced formula cells', () => {
    const data = sheet([row('r1', 'a0', { qty: '=2*3', calc: '=[Qty]+1' })])
    expect(formulaEvaluator(data)('r1', 'calc')).toEqual({ ok: true, value: 7 })
  })

  it('reports errors with #ERROR: division by zero, unknown function, unknown column', () => {
    const data = sheet([row('r1', 'a0', { calc: '=1/0', qty: '=FOO(1)', cost: '=[Nope]+1' })])
    const ev = formulaEvaluator(data)
    expect(ev('r1', 'calc')).toEqual({ ok: false, error: 'Division by zero', display: '#ERROR' })
    expect(ev('r1', 'qty')).toEqual({ ok: false, error: "Unknown function 'FOO'", display: '#ERROR' })
    expect(ev('r1', 'cost')).toEqual({ ok: false, error: "Unknown column 'Nope'", display: '#ERROR' })
  })

  it('an error in a referenced cell propagates', () => {
    const data = sheet([row('r1', 'a0', { qty: '=1/0', calc: '=[Qty]+1' })])
    expect(formulaEvaluator(data)('r1', 'calc')).toMatchObject({ ok: false, display: '#ERROR' })
  })

  it('self references and cycles show #CIRCULAR without hanging', () => {
    const data = sheet([
      row('r1', 'a0', { calc: '=[Calc]+1', qty: '=[Cost]', cost: '=[Qty]' }),
      row('r2', 'a1', { calc: '=SUM([Calc])' }),
    ])
    const ev = formulaEvaluator(data)
    expect(ev('r1', 'calc')).toMatchObject({ ok: false, display: '#CIRCULAR' })
    expect(ev('r1', 'qty')).toMatchObject({ ok: false, display: '#CIRCULAR' })
    expect(ev('r1', 'cost')).toMatchObject({ ok: false, display: '#CIRCULAR' })
    expect(ev('r2', 'calc')).toMatchObject({ ok: false, display: '#CIRCULAR' })
  })

  it('does not evaluate formulas stored in schedule-role columns (shown as stored)', () => {
    const data = sheet([row('r1', 'a0', { start: '=TODAY()' })])
    expect(formulaEvaluator(data)('r1', 'start')).toBeNull()
  })

  it('memoizes per SheetData identity', () => {
    const data = sheet([row('r1', 'a0', { calc: '=1+2' })])
    expect(formulaEvaluator(data)).toBe(formulaEvaluator(data))
    expect(formulaEvaluator({ ...data })).not.toBe(formulaEvaluator(data))
  })

  it('cost guard: 50 =SUM([Cost]) cells over 2,000 rows read each Cost cell about once per cell, with no rebuild per cell', () => {
    let reads = 0
    const rows = Array.from({ length: 2000 }, (_, i) => {
      const cells: Record<string, unknown> = { calc: '=SUM([Cost])' }
      Object.defineProperty(cells, 'cost', {
        enumerable: true,
        get() {
          reads++
          return 1
        },
      })
      return row(`r${i}`, `a${String(i).padStart(5, '0')}`, cells)
    })
    const ev = formulaEvaluator(sheet(rows))
    for (let i = 0; i < 50; i++) expect(ev(`r${i}`, 'calc')).toEqual({ ok: true, value: 2000 })
    // The Cost column's values are collected once (2,000 reads), not once per formula cell (100,000).
    expect(reads).toBeLessThanOrEqual(2000)
  })
})
