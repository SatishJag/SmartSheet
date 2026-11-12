import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import { COL, makeRow, makeSheetData, makeTestStore } from '../test/fixtures'
import type { SheetData } from './persistence'
import type { SheetState } from './sheetStore'

const settled = (store: StoreApi<SheetState>, status = 'saved') =>
  vi.waitFor(() => expect(store.getState().saveStatus).toBe(status))

const titles = (store: StoreApi<SheetState>) => store.getState().data!.columns.map((c) => c.title)
const column = (store: StoreApi<SheetState>, id: string) => store.getState().data!.columns.find((c) => c.id === id)
const cells = (store: StoreApi<SheetState>, rowId: string) => store.getState().data!.rows.find((r) => r.id === rowId)!.cells

/** The fixture sheet with dependencies off, so schedule columns can be changed. */
const noDeps = (over: Partial<SheetData> = {}) => {
  const d = makeSheetData({ dependencies: [], ...over })
  d.sheet.dependenciesEnabled = false
  return d
}

afterEach(() => {
  vi.useRealTimers()
})

describe('addColumn', () => {
  it('appends a column, inserts it at its position and saves the column order', async () => {
    const { store, persistence: p } = await makeTestStore()
    const res = store.getState().addColumn('  Cost ', 'TEXT_NUMBER')
    expect(res.ok).toBe(true)
    const id = (res as { id: string }).id
    expect(titles(store).at(-1)).toBe('Cost')
    await settled(store)
    expect(p.insertColumn).toHaveBeenCalledWith('sheet-1', { id, title: 'Cost', type: 'TEXT_NUMBER' }, 7)
    expect(p.saveColumnOrder).toHaveBeenCalledWith('sheet-1', store.getState().data!.columns.map((c) => c.id))
  })

  it('inserts after a given column', async () => {
    const { store, persistence: p } = await makeTestStore()
    const res = store.getState().addColumn('Trade', 'TEXT_NUMBER', undefined, COL.task)
    expect(titles(store).slice(0, 3)).toEqual(['Task', 'Trade', 'Start'])
    await settled(store)
    expect(p.insertColumn).toHaveBeenCalledWith('sheet-1', expect.objectContaining({ id: (res as { id: string }).id }), 1)
  })

  it('rejects an empty or duplicate title (ignoring case) and changes nothing', async () => {
    const { store, persistence: p } = await makeTestStore()
    expect(store.getState().addColumn(' ', 'TEXT_NUMBER')).toEqual({ ok: false, error: 'Enter a column name' })
    expect(store.getState().addColumn('status', 'TEXT_NUMBER')).toEqual({ ok: false, error: 'A column named "Status" already exists' })
    expect(store.getState().data!.columns).toHaveLength(7)
    await settled(store)
    expect(p.insertColumn).not.toHaveBeenCalled()
  })

  it('requires options for a dropdown and normalizes them', async () => {
    const { store } = await makeTestStore()
    expect(store.getState().addColumn('Trade', 'PICKLIST')).toEqual({ ok: false, error: 'Add at least one option' })
    const res = store.getState().addColumn('Trade', 'MULTI_PICKLIST', [' Electrical ', 'Plumbing', 'Plumbing', ''])
    expect(column(store, (res as { id: string }).id)).toMatchObject({ options: ['Electrical', 'Plumbing'] })
  })

  it('does not create predecessor columns, or insert after an unknown column', async () => {
    const { store } = await makeTestStore()
    expect(store.getState().addColumn('Deps', 'PREDECESSOR').ok).toBe(false)
    expect(store.getState().addColumn('X', 'TEXT_NUMBER', undefined, 'nope')).toEqual({ ok: false, error: 'Unknown column nope' })
  })

  it('cells of the new column can be edited and saved', async () => {
    const { store, persistence: p } = await makeTestStore()
    const { id } = store.getState().addColumn('Cost', 'TEXT_NUMBER') as { id: string }
    expect(store.getState().setCell('r-found', id, '1200')).toEqual({ ok: true })
    await settled(store)
    expect(p.saveCell).toHaveBeenCalledWith('r-found', id, 1200, 0)
  })

  it('a failed insert counts as failed and is re-sent by retryFailed', async () => {
    const { store, persistence: p } = await makeTestStore()
    p.insertColumn.mockRejectedValue(new Error('offline'))
    const { id } = store.getState().addColumn('Cost', 'TEXT_NUMBER') as { id: string }
    await settled(store, 'failed')
    expect(store.getState().failedCount).toBe(1)
    p.insertColumn.mockResolvedValue(undefined)
    p.insertColumn.mockClear()
    store.getState().retryFailed()
    await settled(store)
    expect(p.insertColumn).toHaveBeenCalledWith('sheet-1', expect.objectContaining({ id }), 7)
    expect(store.getState().failedCount).toBe(0)
  })
})

describe('renameColumn', () => {
  it('renames and saves the column', async () => {
    const { store, persistence: p } = await makeTestStore()
    expect(store.getState().renameColumn(COL.status, ' State ')).toEqual({ ok: true })
    expect(column(store, COL.status)!.title).toBe('State')
    await settled(store)
    expect(p.updateColumn).toHaveBeenCalledWith(expect.objectContaining({ id: COL.status, title: 'State', role: 'status' }))
  })

  it('rejects a duplicate or empty title, but allows changing the case of its own', async () => {
    const { store } = await makeTestStore()
    expect(store.getState().renameColumn(COL.status, 'task')).toEqual({ ok: false, error: 'A column named "Task" already exists' })
    expect(store.getState().renameColumn(COL.status, '')).toEqual({ ok: false, error: 'Enter a column name' })
    expect(store.getState().renameColumn(COL.status, 'STATUS')).toEqual({ ok: true })
    expect(store.getState().renameColumn('nope', 'X')).toEqual({ ok: false, error: 'Unknown column nope' })
  })

  it('rewrites [Old Title] references in formula cells and saves them in one call per column', async () => {
    const data = makeSheetData({ dependencies: [] })
    data.columns = [...data.columns, { id: 'c-note', title: 'Note', type: 'TEXT_NUMBER' }]
    data.rows[1].cells['c-note'] = '=[Status] + "!"'
    data.rows[2].cells['c-note'] = '=[Task]'
    data.rows[3].cells['c-note'] = '=IF([Status] = "Done", 1, 0)'
    const { store, persistence: p } = await makeTestStore(data)
    store.getState().renameColumn(COL.status, 'State')
    expect(cells(store, 'r-survey')['c-note']).toBe('=[State] + "!"')
    expect(cells(store, 'r-clear')['c-note']).toBe('=[Task]')
    expect(cells(store, 'r-found')['c-note']).toBe('=IF([State] = "Done", 1, 0)')
    await settled(store)
    expect(p.saveColumnCells).toHaveBeenCalledTimes(1)
    expect(p.saveColumnCells).toHaveBeenCalledWith('sheet-1', 'c-note', {
      'r-survey': '=[State] + "!"',
      'r-found': '=IF([State] = "Done", 1, 0)',
    })
    expect(p.saveCell).not.toHaveBeenCalled()
  })
})

describe('deleteColumn', () => {
  it('removes the column and its values in one persistence call (no per-row saves)', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => makeRow(`r${i}`, `a${String(i).padStart(5, '0')}`, { [COL.task]: 'T', [COL.status]: 'Done' }))
    const { store, persistence: p } = await makeTestStore(makeSheetData({ rows, dependencies: [] }))
    expect(store.getState().deleteColumn(COL.status)).toEqual({ ok: true })
    expect(column(store, COL.status)).toBeUndefined()
    expect(store.getState().data!.rows.every((r) => !(COL.status in r.cells) && r.cells[COL.task] === 'T')).toBe(true)
    await settled(store)
    expect(p.deleteColumn).toHaveBeenCalledWith('sheet-1', COL.status)
    expect(p.saveCell).not.toHaveBeenCalled()
    expect(p.saveColumnCells).not.toHaveBeenCalled()
  })

  it('refuses the primary column and schedule columns while dependencies are enabled', async () => {
    const { store, persistence: p } = await makeTestStore()
    expect(store.getState().deleteColumn(COL.task)).toEqual({ ok: false, error: 'The primary column cannot be deleted' })
    expect(store.getState().deleteColumn(COL.start).ok).toBe(false)
    expect(store.getState().deleteColumn(COL.predecessors).ok).toBe(false)
    expect(store.getState().data!.columns).toHaveLength(7)
    await settled(store)
    expect(p.deleteColumn).not.toHaveBeenCalled()
  })

  it('refuses to delete a schedule column even when dependencies are off', async () => {
    const { store } = await makeTestStore(noDeps())
    expect(store.getState().deleteColumn(COL.duration)).toMatchObject({ ok: false, error: expect.stringMatching(/used for scheduling/) })
  })

  it("clears the column's cell errors and failed saves, and never re-sends them", async () => {
    const { store, persistence: p } = await makeTestStore()
    store.getState().setCell('r-found', COL.status, 'Bogus')
    expect(store.getState().errors).toHaveLength(1)
    p.saveCell.mockRejectedValue(new Error('offline'))
    store.getState().setCell('r-found', COL.status, 'Done')
    await settled(store, 'failed')
    store.getState().deleteColumn(COL.status)
    expect(store.getState().errors).toEqual([])
    await settled(store)
    expect(store.getState().failedCount).toBe(0)
    p.saveCell.mockClear()
    store.getState().retryFailed()
    await settled(store)
    expect(p.saveCell).not.toHaveBeenCalled()
  })

  it('a cell save queued before the delete does not write the value back afterwards', async () => {
    const { store, persistence: p } = await makeTestStore()
    let release!: () => void
    p.saveCell.mockImplementationOnce(() => new Promise((r) => (release = () => r({ version: 1 }))))
    store.getState().setCell('r-found', COL.task, 'Busy') // in flight
    store.getState().setCell('r-found', COL.status, 'Done') // queued
    store.getState().deleteColumn(COL.status)
    release()
    await settled(store)
    expect(p.saveCell.mock.calls.map((c) => c[1])).toEqual([COL.task])
    expect(p.deleteColumn).toHaveBeenCalledTimes(1)
  })

  it('a failed delete is re-sent by retryFailed', async () => {
    const { store, persistence: p } = await makeTestStore()
    p.deleteColumn.mockRejectedValue(new Error('offline'))
    store.getState().deleteColumn(COL.status)
    await settled(store, 'failed')
    p.deleteColumn.mockResolvedValue(undefined)
    p.deleteColumn.mockClear()
    store.getState().retryFailed()
    await settled(store)
    expect(p.deleteColumn).toHaveBeenCalledWith('sheet-1', COL.status)
  })

  it('deleting a column whose insert failed still deletes it (the insert may have landed)', async () => {
    const { store, persistence: p } = await makeTestStore()
    p.insertColumn.mockRejectedValue(new Error('offline'))
    const { id } = store.getState().addColumn('Cost', 'TEXT_NUMBER') as { id: string }
    await settled(store, 'failed')
    store.getState().deleteColumn(id)
    await settled(store)
    expect(store.getState().failedCount).toBe(0)
    expect(p.deleteColumn).toHaveBeenCalledWith(expect.any(String), id)
  })
})

describe('setColumnOptions', () => {
  it('replaces the options of a dropdown column and keeps existing values', async () => {
    const { store, persistence: p } = await makeTestStore()
    expect(store.getState().setColumnOptions(COL.status, ['Open', 'Done', ' Blocked '])).toEqual({ ok: true })
    expect(column(store, COL.status)!.options).toEqual(['Open', 'Done', 'Blocked'])
    expect(cells(store, 'r-clear')[COL.status]).toBe('In progress')
    await settled(store)
    expect(p.updateColumn).toHaveBeenCalledWith(expect.objectContaining({ id: COL.status, options: ['Open', 'Done', 'Blocked'] }))
  })

  it('rejects options for a non-dropdown column, and an empty list', async () => {
    const { store } = await makeTestStore()
    expect(store.getState().setColumnOptions(COL.task, ['A'])).toEqual({ ok: false, error: 'Only dropdown columns have options' })
    expect(store.getState().setColumnOptions(COL.status, [' '])).toEqual({ ok: false, error: 'Add at least one option' })
  })
})

describe('changeColumnType', () => {
  it('keeps values that fit, clears the others, says how many, and saves only changed rows', async () => {
    const data = noDeps()
    data.columns = [...data.columns, { id: 'c-due', title: 'Due', type: 'TEXT_NUMBER' }]
    data.rows[0].cells['c-due'] = '2026-12-01'
    data.rows[1].cells['c-due'] = 'next week'
    data.rows[2].cells['c-due'] = 42
    data.rows[3].cells['c-due'] = '=[Task]'
    const { store, persistence: p } = await makeTestStore(data)
    expect(store.getState().changeColumnType('c-due', 'DATE')).toEqual({ ok: true })
    expect(column(store, 'c-due')).toEqual({ id: 'c-due', title: 'Due', type: 'DATE' })
    expect(cells(store, 'r-site')['c-due']).toBe('2026-12-01')
    expect('c-due' in cells(store, 'r-survey')).toBe(false)
    expect('c-due' in cells(store, 'r-clear')).toBe(false)
    expect(cells(store, 'r-found')['c-due']).toBe('=[Task]')
    expect(store.getState().notices).toEqual(['Changed "Due" to Date: cleared 2 values that did not fit'])
    await settled(store)
    expect(p.updateColumn).toHaveBeenCalledWith({ id: 'c-due', title: 'Due', type: 'DATE' })
    expect(p.saveColumnCells).toHaveBeenCalledWith('sheet-1', 'c-due', { 'r-survey': undefined, 'r-clear': undefined })
    expect(Object.keys(p.saveColumnCells.mock.calls[0][2])).toEqual(['r-survey', 'r-clear'])
  })

  it('normalizes values for the new type (text to dropdown)', async () => {
    const data = noDeps()
    data.columns = [...data.columns, { id: 'c-trade', title: 'Trade', type: 'TEXT_NUMBER' }]
    data.rows[0].cells['c-trade'] = 'Electrical'
    data.rows[1].cells['c-trade'] = 'Roofing'
    const { store, persistence: p } = await makeTestStore(data)
    store.getState().changeColumnType('c-trade', 'MULTI_PICKLIST', ['Electrical', 'Plumbing'])
    expect(cells(store, 'r-site')['c-trade']).toEqual(['Electrical'])
    expect(store.getState().notices).toEqual(['Changed "Trade" to Dropdown (multiple): cleared 1 value that did not fit'])
    await settled(store)
    expect(p.saveColumnCells).toHaveBeenCalledWith('sheet-1', 'c-trade', { 'r-site': ['Electrical'], 'r-survey': undefined })
  })

  it('posts no notice when nothing was cleared, and drops the special role', async () => {
    const { store } = await makeTestStore(noDeps())
    expect(store.getState().changeColumnType(COL.status, 'TEXT_NUMBER')).toEqual({ ok: true })
    expect(column(store, COL.status)).toEqual({ id: COL.status, title: 'Status', type: 'TEXT_NUMBER' })
    expect(cells(store, 'r-clear')[COL.status]).toBe('In progress')
    expect(store.getState().notices).toEqual([])
  })

  it('refuses locked columns, predecessor type and dropdowns without options', async () => {
    const { store } = await makeTestStore()
    expect(store.getState().changeColumnType(COL.task, 'DATE')).toEqual({ ok: false, error: 'The primary column cannot change type' })
    expect(store.getState().changeColumnType(COL.duration, 'TEXT_NUMBER').ok).toBe(false)
    expect(store.getState().changeColumnType(COL.status, 'PREDECESSOR').ok).toBe(false)
    expect(store.getState().changeColumnType(COL.percent, 'PICKLIST', []).ok).toBe(false)
    expect(column(store, COL.duration)!.type).toBe('DURATION')
  })

  it('a failed bulk save is re-sent by retryFailed with the current values', async () => {
    const data = noDeps()
    data.columns = [...data.columns, { id: 'c-due', title: 'Due', type: 'TEXT_NUMBER' }]
    data.rows[1].cells['c-due'] = 'later'
    const { store, persistence: p } = await makeTestStore(data)
    p.saveColumnCells.mockRejectedValue(new Error('offline'))
    store.getState().changeColumnType('c-due', 'DATE')
    await settled(store, 'failed')
    p.saveColumnCells.mockResolvedValue(undefined)
    p.saveColumnCells.mockClear()
    store.getState().retryFailed()
    await settled(store)
    expect(p.saveColumnCells).toHaveBeenCalledWith('sheet-1', 'c-due', { 'r-survey': undefined })
  })
})
