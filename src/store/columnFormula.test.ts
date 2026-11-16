import { describe, expect, it } from 'vitest'
import { formulaEvaluator } from '../formula/sheetFormulas'
import { makeRow, makeSheetData, makeTestStore } from '../test/fixtures'
import type { Column } from '../model/validate'

const columns: Column[] = [
  { id: 'task', title: 'Task', type: 'TEXT_NUMBER' },
  { id: 'qty', title: 'Qty', type: 'TEXT_NUMBER' },
  { id: 'rate', title: 'Rate', type: 'TEXT_NUMBER' },
  { id: 'total', title: 'Total', type: 'TEXT_NUMBER' },
  { id: 'start', title: 'Start', type: 'DATE', role: 'start' },
  { id: 'done', title: 'Done', type: 'CHECKBOX' },
]

const sheet = () =>
  makeSheetData({
    columns,
    rows: [
      makeRow('r1', 'a0', { task: 'A', qty: 2, rate: 10 }),
      makeRow('r2', 'a1', { task: 'B', qty: 3, rate: 5 }),
      makeRow('r3', 'a2', { task: 'C', qty: 4, rate: 2 }),
    ],
    dependencies: [],
  })

/** Rows with only a Task and a Qty: Rate and Total are empty, so a column formula applies to them. */
const qtyOnly = () => [makeRow('r1', 'a0', { task: 'A', qty: 2 }), makeRow('r2', 'a1', { task: 'B', qty: 3 }), makeRow('r3', 'a2', { task: 'C', qty: 4 })]

async function setup(rows = sheet().rows) {
  const { store, persistence } = await makeTestStore(makeSheetData({ columns, rows, dependencies: [] }))
  const value = (rowId: string, colId = 'total') => formulaEvaluator(store.getState().data!)(rowId, colId)
  return { store, persistence, value, state: () => store.getState() }
}

describe('setColumnFormula', () => {
  it('applies the formula to every row, with or without a leading =', async () => {
    const { state, value } = await setup()
    expect(state().setColumnFormula('total', '[Qty] * [Rate]')).toEqual({ ok: true })
    expect(state().data!.columns.find((c) => c.id === 'total')!.formula).toBe('=[Qty] * [Rate]')
    expect(value('r1')).toEqual({ ok: true, value: 20, columnFormula: '=[Qty] * [Rate]' })
    expect(value('r2')).toMatchObject({ ok: true, value: 15 })
    expect(value('r3')).toMatchObject({ ok: true, value: 8 })
  })

  it('saves the column definition (with the formula), once per change', async () => {
    const { state, persistence } = await setup()
    state().setColumnFormula('total', '=[Qty]*[Rate]')
    await new Promise((r) => setTimeout(r, 0))
    expect(persistence.updateColumn).toHaveBeenCalledTimes(1)
    expect(persistence.updateColumn).toHaveBeenCalledWith(expect.objectContaining({ id: 'total', formula: '=[Qty]*[Rate]' }))
    expect(state().setColumnFormula('total', '=[Qty]*[Rate]')).toEqual({ ok: true }) // unchanged: no save
    await new Promise((r) => setTimeout(r, 0))
    expect(persistence.updateColumn).toHaveBeenCalledTimes(1)
  })

  it('refuses a formula that cannot be read and says why', async () => {
    const { state } = await setup()
    expect(state().setColumnFormula('total', '=1+')).toMatchObject({ ok: false, error: expect.stringContaining('#UNPARSEABLE') })
    expect(state().setColumnFormula('total', '=SQRT(1,2)')).toMatchObject({ ok: false, error: expect.stringContaining('#INCORRECT ARGUMENT SET') })
    expect(state().setColumnFormula('total', '=FOO(1)')).toMatchObject({ ok: false, error: expect.stringContaining("Unknown function 'FOO'") })
    expect(state().data!.columns.find((c) => c.id === 'total')!.formula).toBeUndefined()
  })

  it('a formula that is readable but wrong in a row shows the error there, not on save', async () => {
    const { state, value } = await setup()
    expect(state().setColumnFormula('total', '=[Qty]/0')).toEqual({ ok: true })
    expect(value('r1')).toMatchObject({ ok: false, error: '#DIVIDE BY ZERO' })
  })

  it('refuses the primary column, and a schedule column while dependencies are on', async () => {
    const { state } = await setup()
    expect(state().setColumnFormula('task', '=1')).toEqual({ ok: false, error: 'The primary column cannot have a column formula' })
    const { store } = await makeTestStore(makeSheetData({ columns, rows: sheet().rows, dependencies: [] }))
    store.setState((s) => ({ data: { ...s.data!, sheet: { ...s.data!.sheet, dependenciesEnabled: true } } }))
    expect(store.getState().setColumnFormula('start', '=TODAY()')).toEqual({ ok: false, error: 'Formulas are not allowed in start columns' })
  })

  it('refuses an unknown column, ignores clearing a column without a formula, and clears one that has it', async () => {
    const { state, value } = await setup()
    expect(state().setColumnFormula('nope', '=1')).toMatchObject({ ok: false })
    expect(state().setColumnFormula('total', '')).toEqual({ ok: true })
    state().setColumnFormula('total', '=1+1')
    expect(value('r1')).toMatchObject({ ok: true, value: 2 })
    expect(state().setColumnFormula('total', null)).toEqual({ ok: true })
    expect('formula' in state().data!.columns.find((c) => c.id === 'total')!).toBe(false)
    expect(value('r1')).toBeNull()
  })

  it('works in a checkbox column: the result is true/false', async () => {
    const { state, value } = await setup()
    state().setColumnFormula('done', '=[Qty]>2')
    expect(value('r1', 'done')).toMatchObject({ ok: true, value: false })
    expect(value('r2', 'done')).toMatchObject({ ok: true, value: true })
  })

  it('an own value or formula overrides the column formula until it is cleared', async () => {
    const { state, value } = await setup()
    state().setColumnFormula('total', '=[Qty]*[Rate]')
    state().setCell('r2', 'total', '99')
    expect(value('r2')).toBeNull() // a plain value: shown as it is
    expect(value('r1')).toMatchObject({ value: 20 })
    state().setCell('r3', 'total', '=[Qty]+1000')
    expect(value('r3')).toEqual({ ok: true, value: 1004 }) // its own formula, not the column's
    state().setCell('r2', 'total', '') // cleared: the column formula is back
    state().setCell('r3', 'total', '')
    expect(value('r2')).toMatchObject({ ok: true, value: 15, columnFormula: '=[Qty]*[Rate]' })
    expect(value('r3')).toMatchObject({ ok: true, value: 8 })
  })

  it('a row added later gets the column formula automatically, and follows its own inputs', async () => {
    const { state, value } = await setup()
    state().setColumnFormula('total', '=[Qty]*[Rate]')
    const id = state().addRow('r3')
    expect(value(id)).toMatchObject({ ok: true, value: 0 }) // blank * blank
    state().setCell(id, 'qty', '6')
    state().setCell(id, 'rate', '7')
    expect(value(id)).toMatchObject({ ok: true, value: 42 })
  })

  it('results follow edits to the cells they depend on', async () => {
    const { state, value } = await setup()
    state().setColumnFormula('total', '=[Qty]*[Rate]')
    expect(value('r1')).toMatchObject({ value: 20 })
    state().setCell('r1', 'qty', '5')
    expect(value('r1')).toMatchObject({ value: 50 })
    expect(value('r2')).toMatchObject({ value: 15 })
  })

  it('a column formula that refers to its own column is #CIRCULAR REFERENCE in every row', async () => {
    const { state, value } = await setup()
    state().setColumnFormula('total', '=[Total]+1')
    for (const id of ['r1', 'r2', 'r3']) expect(value(id)).toMatchObject({ ok: false, error: '#CIRCULAR REFERENCE' })
    state().setColumnFormula('total', '=SUM(Total:Total)')
    for (const id of ['r1', 'r2', 'r3']) expect(value(id)).toMatchObject({ ok: false, error: '#CIRCULAR REFERENCE' })
    state().setColumnFormula('total', '=[Qty]') // fixed: results come back
    expect(value('r1')).toMatchObject({ ok: true, value: 2 })
  })

  it('two column formulas that refer to each other are circular; one that only reads them is #BLOCKED', async () => {
    const { state, value } = await setup(qtyOnly())
    state().setColumnFormula('total', '=[Rate]+1')
    state().setColumnFormula('rate', '=[Total]+1')
    expect(value('r1', 'total')).toMatchObject({ ok: false, error: '#CIRCULAR REFERENCE' })
    expect(value('r1', 'rate')).toMatchObject({ ok: false, error: '#CIRCULAR REFERENCE' })
    state().setColumnFormula('done', '=[Total]>0')
    expect(value('r1', 'done')).toMatchObject({ ok: false, error: '#BLOCKED' })
  })

  it('a sibling column formula chains: Total reads Rate which has its own column formula', async () => {
    const { state, value } = await setup(qtyOnly())
    state().setColumnFormula('rate', '=[Qty]*10')
    state().setColumnFormula('total', '=[Rate]+1')
    expect(value('r2')).toMatchObject({ ok: true, value: 31 }) // Qty 3 -> Rate 30 -> Total 31
    state().setCell('r2', 'qty', '1') // two steps away
    expect(value('r2')).toMatchObject({ ok: true, value: 11 })
  })

  it('works on hierarchy: a parent row rolls up its children with the column formula', async () => {
    const data = makeSheetData({
      columns,
      rows: [
        makeRow('p', 'a0', { task: 'Parent' }),
        makeRow('c1', 'a0', { task: 'C1', qty: 2 }, 'p'),
        makeRow('c2', 'a1', { task: 'C2', qty: 5 }, 'p'),
      ],
      dependencies: [],
    })
    const { store } = await makeTestStore(data)
    store.getState().setColumnFormula('total', '=IF(COUNT(CHILDREN([Qty]@row))=0,[Qty],SUM(CHILDREN([Total]@row)))')
    const ev = (id: string) => formulaEvaluator(store.getState().data!)(id, 'total')
    expect(ev('c1')).toMatchObject({ value: 2 })
    expect(ev('p')).toMatchObject({ value: 7 })
    store.getState().setCell('c2', 'qty', '10')
    expect(ev('p')).toMatchObject({ value: 12 })
    // A new child row appears under the parent: the roll-up includes it.
    const id = store.getState().addRow('c2')
    store.getState().setCell(id, 'qty', '1')
    expect(ev('p')).toMatchObject({ value: 13 })
  })

  it('renaming a column rewrites the references in column formulas (and saves those columns)', async () => {
    const { state, persistence, value } = await setup()
    state().setColumnFormula('total', '=Qty@row*[Rate]')
    await new Promise((r) => setTimeout(r, 0))
    persistence.updateColumn.mockClear()
    expect(state().renameColumn('qty', 'Quantity')).toEqual({ ok: true })
    const total = state().data!.columns.find((c) => c.id === 'total')!
    expect(total.formula).toBe('=Quantity@row*[Rate]')
    expect(value('r1')).toMatchObject({ ok: true, value: 20 })
    await new Promise((r) => setTimeout(r, 0))
    expect(persistence.updateColumn).toHaveBeenCalledWith(expect.objectContaining({ id: 'total', formula: '=Quantity@row*[Rate]' }))
    expect(persistence.updateColumn).toHaveBeenCalledWith(expect.objectContaining({ id: 'qty', title: 'Quantity' }))
  })

  it('changing the column type keeps the formula', async () => {
    const { state } = await setup()
    state().setColumnFormula('total', '=1+1')
    expect(state().changeColumnType('total', 'PICKLIST', ['a'])).toEqual({ ok: true })
    expect(state().data!.columns.find((c) => c.id === 'total')!.formula).toBe('=1+1')
  })

  it('turning dependencies on is refused while a schedule column holds a column formula', async () => {
    const { store } = await makeTestStore(makeSheetData({ columns, rows: sheet().rows, dependencies: [] }))
    expect(store.getState().data!.sheet.dependenciesEnabled).toBe(true) // fixture default
    store.getState().setDependenciesEnabled(false)
    expect(store.getState().setColumnFormula('start', '=TODAY()')).toEqual({ ok: true }) // allowed while off
    const res = store.getState().setDependenciesEnabled(true)
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('column formula of Start') })
  })
})
