import { describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import { COL, fsDep, makeSheetData, makeTestStore } from '../test/fixtures'
import type { SheetData } from './persistence'
import { predecessorString } from './predecessors'
import type { SheetState } from './sheetStore'

// Fixture (2026-11-09 is a Monday, 8h days): 1 r-site (parent of 2 and 3), 2 r-survey (starts
// 11-09, 2d), 3 r-clear (3d), 4 r-found (5d). Dependencies: 2 -> 3 FS, 3 -> 4 FS.

async function settled(store: StoreApi<SheetState>) {
  await vi.waitFor(() => expect(store.getState().saveStatus).toBe('saved'))
}

const preds = (store: StoreApi<SheetState>, rowId: string) => predecessorString(store.getState().data!, rowId)
const deps = (store: StoreApi<SheetState>) => store.getState().data!.dependencies
const errorsOf = (store: StoreApi<SheetState>) => store.getState().errors

describe('editing the predecessor column', () => {
  it('"2FS +1d" on row 3 creates one dependency from row 2 with a 1d lag and reschedules row 3', async () => {
    const { store, persistence } = await makeTestStore()
    expect(store.getState().scheduled.byRow['r-clear'].start).toBe('2026-11-11')

    expect(store.getState().setCell('r-clear', COL.predecessors, '2FS +1d')).toEqual({ ok: true })

    const into = deps(store).filter((d) => d.successorId === 'r-clear')
    expect(into).toEqual([{ predecessorId: 'r-survey', successorId: 'r-clear', type: 'FS', lagMinutes: 480 }])
    expect(store.getState().scheduled.byRow['r-clear'].start).toBe('2026-11-12')
    expect(preds(store, 'r-clear')).toBe('2FS +1d')
    await settled(store)
    expect(persistence.saveDependencies).toHaveBeenCalledTimes(1)
    expect(persistence.saveDependencies).toHaveBeenCalledWith('sheet-1', deps(store))
  })

  it('never writes the predecessor column into cells and never calls saveCell for it', async () => {
    const { store, persistence } = await makeTestStore(makeSheetData({ dependencies: [] }))
    const before = store.getState().data!.rows.find((r) => r.id === 'r-found')!.cells
    store.getState().setCell('r-found', COL.predecessors, '3')
    await settled(store)
    expect(store.getState().data!.rows.find((r) => r.id === 'r-found')!.cells).toEqual(before)
    expect(persistence.saveCell).not.toHaveBeenCalled()
    expect(deps(store)).toEqual([fsDep('r-clear', 'r-found')])
  })

  it('rejects a row that does not exist, recording a cell error and changing nothing', async () => {
    const { store, persistence } = await makeTestStore()
    const before = deps(store)
    expect(store.getState().setCell('r-clear', COL.predecessors, '99')).toEqual({ ok: false, error: 'Row 99 does not exist' })
    expect(deps(store)).toBe(before)
    expect(errorsOf(store)).toEqual([{ rowId: 'r-clear', colId: COL.predecessors, message: 'Row 99 does not exist' }])
    await settled(store)
    expect(persistence.saveDependencies).not.toHaveBeenCalled()
  })

  it('rejects the row\'s own number', async () => {
    const { store } = await makeTestStore()
    const before = deps(store)
    expect(store.getState().setCell('r-clear', COL.predecessors, '3')).toEqual({ ok: false, error: 'A row cannot depend on itself' })
    expect(deps(store)).toBe(before)
  })

  it('rejects a cycle, naming the rows by number, and changes nothing', async () => {
    const { store, persistence } = await makeTestStore()
    const before = deps(store)
    expect(store.getState().setCell('r-survey', COL.predecessors, '3')).toEqual({
      ok: false,
      error: 'Dependency would create a cycle: row 2 -> row 3 -> row 2',
    })
    expect(deps(store)).toBe(before)
    expect(errorsOf(store)).toHaveLength(1)
    await settled(store)
    expect(persistence.saveDependencies).not.toHaveBeenCalled()
  })

  it('rejects the same row listed twice', async () => {
    const { store } = await makeTestStore()
    const before = deps(store)
    expect(store.getState().setCell('r-found', COL.predecessors, '2FS, 2SS')).toEqual({
      ok: false,
      error: 'Row 2 is listed more than once',
    })
    expect(deps(store)).toBe(before)
  })

  it('replaces the row\'s dependencies in one save of the full set', async () => {
    const { store, persistence } = await makeTestStore()
    expect(store.getState().setCell('r-found', COL.predecessors, '2SS')).toEqual({ ok: true })
    await settled(store)
    const expected = [fsDep('r-survey', 'r-clear'), { predecessorId: 'r-survey', successorId: 'r-found', type: 'SS', lagMinutes: 0 }]
    expect(deps(store)).toEqual(expected)
    expect(persistence.saveDependencies).toHaveBeenCalledTimes(1)
    expect(persistence.saveDependencies).toHaveBeenCalledWith('sheet-1', expected)
  })

  it('replacing "2FS" by "1SS" removes the old dependency and adds the new one', async () => {
    const data = makeSheetData({ dependencies: [fsDep('r-survey', 'r-found')] })
    const { store, persistence } = await makeTestStore(data)
    expect(preds(store, 'r-found')).toBe('2FS')
    store.getState().setCell('r-found', COL.predecessors, '1SS')
    await settled(store)
    const expected = [{ predecessorId: 'r-site', successorId: 'r-found', type: 'SS', lagMinutes: 0 }]
    expect(deps(store)).toEqual(expected)
    expect(persistence.saveDependencies).toHaveBeenCalledTimes(1)
    expect(persistence.saveDependencies).toHaveBeenCalledWith('sheet-1', expected)
  })

  it('clearing the cell removes the row\'s dependencies', async () => {
    const { store, persistence } = await makeTestStore()
    expect(store.getState().setCell('r-clear', COL.predecessors, '')).toEqual({ ok: true })
    expect(deps(store)).toEqual([fsDep('r-clear', 'r-found')])
    expect(preds(store, 'r-clear')).toBe('')
    await settled(store)
    expect(persistence.saveDependencies).toHaveBeenCalledWith('sheet-1', [fsDep('r-clear', 'r-found')])
  })

  it('a successful edit clears an earlier error on the cell', async () => {
    const { store } = await makeTestStore()
    store.getState().setCell('r-clear', COL.predecessors, '99')
    expect(errorsOf(store)).toHaveLength(1)
    expect(store.getState().setCell('r-clear', COL.predecessors, '2FS +2d')).toEqual({ ok: true })
    expect(errorsOf(store)).toEqual([])
  })

  it('setPredecessors is the action behind the column', async () => {
    const { store } = await makeTestStore()
    expect(store.getState().setPredecessors('r-found', '2')).toEqual({ ok: true })
    expect(preds(store, 'r-found')).toBe('2FS')
  })

  it('rejects when dependencies are not enabled for the sheet', async () => {
    const data = makeSheetData()
    data.sheet.dependenciesEnabled = false
    const { store } = await makeTestStore(data)
    const before = deps(store)
    expect(store.getState().setCell('r-found', COL.predecessors, '2')).toEqual({
      ok: false,
      error: 'Dependencies are not enabled for this sheet',
    })
    expect(deps(store)).toBe(before)
    expect(errorsOf(store)).toHaveLength(1)
  })

  it('rejects predecessors on a parent row', async () => {
    const { store } = await makeTestStore()
    expect(store.getState().setCell('r-site', COL.predecessors, '4')).toEqual({
      ok: false,
      error: 'Summary rows cannot have predecessors',
    })
  })

  it('allows a parent row as predecessor: the successor starts after the parent\'s rolled-up end', async () => {
    const { store } = await makeTestStore()
    expect(store.getState().setCell('r-found', COL.predecessors, '1')).toEqual({ ok: true })
    expect(deps(store)).toEqual([fsDep('r-survey', 'r-clear'), fsDep('r-site', 'r-found')])
    const { byRow } = store.getState().scheduled
    expect(byRow['r-site'].end).toBe('2026-11-13')
    expect(byRow['r-found'].start).toBe('2026-11-16')
  })

  it('works on a row that is not persisted yet: the row is inserted before the dependency save', async () => {
    const { store, persistence } = await makeTestStore()
    const id = store.getState().addRow('r-found')
    expect(store.getState().setCell(id, COL.predecessors, '4')).toEqual({ ok: true })
    await settled(store)
    expect(persistence.insertRow.mock.invocationCallOrder[0]).toBeLessThan(
      persistence.saveDependencies.mock.invocationCallOrder[0],
    )
    expect(preds(store, id)).toBe('4FS')
  })
})

describe('row changes keep predecessor strings correct', () => {
  it('moving row 2 below row 3 renumbers row 3\'s string without saving dependencies', async () => {
    const { store, persistence } = await makeTestStore()
    store.getState().moveRow('r-survey', 'r-clear', 'r-site')
    // New order: 1 site, 2 clear, 3 survey, 4 found.
    expect(preds(store, 'r-clear')).toBe('3FS')
    expect(preds(store, 'r-found')).toBe('2FS')
    await settled(store)
    expect(persistence.saveDependencies).not.toHaveBeenCalled()
  })

  it('outdent and indent keep the strings in step without saving dependencies', async () => {
    const { store, persistence } = await makeTestStore()
    store.getState().outdentRow('r-survey')
    // New order: 1 site, 2 clear, 3 survey, 4 found.
    expect(preds(store, 'r-clear')).toBe('3FS')
    expect(preds(store, 'r-found')).toBe('2FS')
    store.getState().indentRow('r-found')
    // found becomes the last child of survey: order unchanged.
    expect(preds(store, 'r-found')).toBe('2FS')
    expect(preds(store, 'r-clear')).toBe('3FS')
    await settled(store)
    expect(persistence.saveDependencies).not.toHaveBeenCalled()
  })

  it('deleting a predecessor row removes its dependency, adds a notice and renumbers', async () => {
    const { store, persistence } = await makeTestStore()
    store.getState().deleteRow('r-survey')
    expect(deps(store)).toEqual([fsDep('r-clear', 'r-found')])
    expect(store.getState().notices).toEqual(['Removed 1 dependency that referenced deleted rows'])
    expect(preds(store, 'r-clear')).toBe('')
    expect(preds(store, 'r-found')).toBe('2FS')
    await settled(store)
    expect(persistence.saveDependencies).toHaveBeenCalledWith('sheet-1', [fsDep('r-clear', 'r-found')])
  })
})

describe('one dependency per pair', () => {
  it('addDependency rejects a second dependency between the same rows, whatever its type', async () => {
    const data: SheetData = makeSheetData({ dependencies: [] })
    const { store } = await makeTestStore(data)
    expect(store.getState().addDependency(fsDep('r-survey', 'r-found'))).toEqual({ ok: true })
    expect(
      store.getState().addDependency({ predecessorId: 'r-survey', successorId: 'r-found', type: 'SS', lagMinutes: 0 }),
    ).toEqual({ ok: false, error: 'A dependency between these rows already exists' })
    expect(deps(store)).toEqual([fsDep('r-survey', 'r-found')])
  })
})
