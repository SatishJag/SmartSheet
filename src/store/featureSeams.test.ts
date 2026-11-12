import { describe, expect, it } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import { COL, fixtureColumns, makeRow, makeSheetData, makeTestStore } from '../test/fixtures'
import type { SheetState } from './sheetStore'

/**
 * Regressions at the seams between column management, schedule settings and the persistence
 * queue (found in review after the three features were merged).
 */

const settled = async (store: StoreApi<SheetState>) => {
  for (let i = 0; i < 200 && store.getState().saveStatus !== 'saved'; i++) await new Promise((r) => setTimeout(r, 1))
  expect(store.getState().saveStatus).toBe('saved')
}

/** A promise and its resolver, to hold the persistence queue busy. */
function gate() {
  let open!: () => void
  const promise = new Promise<void>((r) => (open = r))
  return { promise, open }
}

describe('queued cell write vs. bulk column write', () => {
  it('a cell job queued behind a merged colcells job does not overwrite the newer value', async () => {
    const extra = [
      { id: 'c-a', title: 'A', type: 'TEXT_NUMBER' as const },
      { id: 'c-x', title: 'X', type: 'TEXT_NUMBER' as const },
      { id: 'c-f', title: 'F', type: 'TEXT_NUMBER' as const },
    ]
    const data = makeSheetData({ columns: [...fixtureColumns, ...extra] })
    data.rows = data.rows.map((r) => (r.id === 'r-found' ? makeRow(r.id, r.position, { ...r.cells, 'c-f': '=[X]' }, r.parentId) : r))
    const { store, persistence: p } = await makeTestStore(data)

    // What the database ends up holding for (r-found, c-f), in write order.
    const writes: unknown[] = []
    p.saveCell.mockImplementation(async (rowId, colId, value, version) => {
      if (rowId === 'r-found' && colId === 'c-f') writes.push(value)
      return { version: version + 1 }
    })
    p.saveColumnCells.mockImplementation(async (_s, colId, values) => {
      if (colId === 'c-f' && 'r-found' in values) writes.push(values['r-found'])
    })

    // Keep the queue busy so the following jobs wait (and merge) in it.
    const g = gate()
    p.saveSheetSettings.mockImplementation(() => g.promise)
    const s = store.getState()
    expect(s.setCalendar({ ...data.sheet.calendar, hoursPerDay: 7 }).ok).toBe(true)

    expect(s.renameColumn('c-x', 'Y').ok).toBe(true) // queues colcells:c-f for r-found ("=[Y]")
    expect(s.setCell('r-found', 'c-f', '=[A]+1').ok).toBe(true) // queues cell:r-found:c-f carrying "=[A]+1"
    expect(s.renameColumn('c-a', 'B').ok).toBe(true) // local "=[B]+1"; colcells merges into the EARLIER job
    expect(store.getState().data!.rows.find((r) => r.id === 'r-found')!.cells['c-f']).toBe('=[B]+1')

    g.open()
    await settled(store)
    // The database must end with what the user sees; it ends with the stale "=[A]+1".
    expect(writes.at(-1)).toBe('=[B]+1')
  })
})

describe('schedule columns while dependencies are off', () => {
  it('the Predecessors column cannot be retyped or deleted, so re-enabling keeps dependencies editable', async () => {
    const data = makeSheetData()
    data.sheet.dependenciesEnabled = false // dependencies r-survey -> r-clear -> r-found are kept
    const { store } = await makeTestStore(data)

    expect(store.getState().changeColumnType(COL.predecessors, 'TEXT_NUMBER').ok).toBe(false)
    expect(store.getState().deleteColumn(COL.predecessors).ok).toBe(false)
    expect(store.getState().setDependenciesEnabled(true)).toEqual({ ok: true })
    expect(store.getState().data!.columns.some((c) => c.role === 'predecessor')).toBe(true)
  })

  it('refuses to turn dependencies on when a sheet has dependencies but no Predecessors column', async () => {
    const data = makeSheetData()
    data.sheet.dependenciesEnabled = false
    data.columns = data.columns.filter((c) => c.id !== COL.predecessors) // e.g. legacy data
    const { store } = await makeTestStore(data)
    expect(store.getState().setDependenciesEnabled(true)).toMatchObject({ ok: false, error: expect.stringMatching(/no Predecessors column/) })
    expect(store.getState().data!.sheet.dependenciesEnabled).toBe(false)
  })
})

describe('column insert whose response is lost, then deleted', () => {
  it('is still deleted from the database', async () => {
    const { store, persistence: p } = await makeTestStore(makeSheetData(), { retryDelaysMs: [30] })
    const db = new Set<string>()
    p.insertColumn.mockImplementationOnce(async (_s, col) => {
      db.add(col.id) // the insert reached the database...
      throw new Error('network: response lost') // ...but the client never heard back
    })
    p.insertColumn.mockImplementation(async (_s, col) => void db.add(col.id))
    p.deleteColumn.mockImplementation(async (_s, colId) => void db.delete(colId))

    const { id } = store.getState().addColumn('Cost', 'TEXT_NUMBER') as { id: string }
    await new Promise((r) => setTimeout(r, 5)) // first attempt failed, retry pending
    expect(store.getState().deleteColumn(id).ok).toBe(true)
    await settled(store)

    expect(db.has(id)).toBe(false) // would otherwise come back on the next load
  })
})
