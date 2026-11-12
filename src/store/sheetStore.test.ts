import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultCalendar } from '../engine/calendar'
import type { SchedDep } from '../engine/schedule'
import type { Column } from '../model/validate'
import type { Persistence, RowRecord, SheetData } from './persistence'
import { createSheetStore } from './sheetStore'

// 2026-11-09 is a Monday.
const columns: Column[] = [
  { id: 'name', title: 'Task', type: 'TEXT_NUMBER' },
  { id: 'start', title: 'Start', type: 'DATE', role: 'start' },
  { id: 'dur', title: 'Duration', type: 'DURATION', role: 'duration' },
  { id: 'pct', title: '% Complete', type: 'TEXT_NUMBER', role: 'percentComplete' },
  { id: 'status', title: 'Status', type: 'PICKLIST', role: 'status', options: ['Open', 'Done'] },
]

const rec = (id: string, position: string, cells: Record<string, unknown>, parentId: string | null = null): RowRecord => ({
  id,
  parentId,
  position,
  cells,
  version: 0,
})

const fs = (predecessorId: string, successorId: string): SchedDep => ({ predecessorId, successorId, type: 'FS', lagMinutes: 0 })

function sheetData(over: Partial<SheetData> = {}): SheetData {
  return {
    sheet: { id: 'sh', name: 'Tower', ownerId: 'u', workspaceId: 'u', calendar: defaultCalendar, dependenciesEnabled: true },
    columns,
    rows: [
      rec('r1', 'a0', { name: 'Excavate', start: '2026-11-09', dur: '2d', status: 'Open' }),
      rec('r2', 'a1', { name: 'Pour', dur: '3d' }),
    ],
    dependencies: [fs('r1', 'r2')],
    ...over,
  }
}

function fakePersistence(data: SheetData = sheetData()) {
  return {
    loadSheet: vi.fn(async (_id: string) => structuredClone(data)),
    saveCell: vi.fn(async (_r: string, _c: string, _v: unknown, version: number) => ({ version: version + 1 })),
    insertRow: vi.fn(async (_s: string, _r: RowRecord) => {}),
    saveRowTree: vi.fn(async () => {}),
    saveDependencies: vi.fn(async () => {}),
    deleteRows: vi.fn(async () => {}),
  } satisfies Persistence
}

async function loaded(p = fakePersistence(), data?: SheetData) {
  if (data) p.loadSheet.mockResolvedValue(structuredClone(data))
  const store = createSheetStore(p, { retryDelaysMs: [0, 0, 0] })
  await store.getState().load('sh')
  return { store, p }
}

const cell = (store: Awaited<ReturnType<typeof loaded>>['store'], rowId: string, colId: string) =>
  store.getState().data!.rows.find((r) => r.id === rowId)!.cells[colId]

const settled = (store: Awaited<ReturnType<typeof loaded>>['store'], status = 'saved') =>
  vi.waitFor(() => expect(store.getState().saveStatus).toBe(status))

afterEach(() => {
  vi.useRealTimers()
})

describe('load', () => {
  it('sets data and the schedule', async () => {
    const { store } = await loaded()
    const s = store.getState()
    expect(s.data!.rows).toHaveLength(2)
    expect(s.loadError).toBeNull()
    expect(s.saveStatus).toBe('saved')
    expect(s.scheduled.byRow.r1).toMatchObject({ start: '2026-11-09', end: '2026-11-10' })
    expect(s.scheduled.byRow.r2).toMatchObject({ start: '2026-11-11', end: '2026-11-13' })
  })

  it('records a load failure in loadError', async () => {
    const p = fakePersistence()
    p.loadSheet.mockRejectedValue(new Error('network down'))
    const store = createSheetStore(p)
    await store.getState().load('sh')
    expect(store.getState().loadError).toBe('network down')
    expect(store.getState().data).toBeNull()
  })
})

describe('setCell', () => {
  it('updates state optimistically before the save resolves', async () => {
    const { store, p } = await loaded()
    let resolve!: (v: { version: number }) => void
    p.saveCell.mockImplementation(() => new Promise((r) => (resolve = r)))
    expect(store.getState().setCell('r1', 'name', 'Dig')).toEqual({ ok: true })
    expect(cell(store, 'r1', 'name')).toBe('Dig')
    expect(store.getState().saveStatus).toBe('saving')
    expect(p.saveCell).toHaveBeenCalledWith('r1', 'name', 'Dig', 0)
    resolve({ version: 7 })
    await settled(store)
    expect(store.getState().data!.rows[0].version).toBe(7)
  })

  it('keeps the old value and records one error for an invalid value', async () => {
    const { store, p } = await loaded()
    const r1 = store.getState().setCell('r1', 'start', 'next tuesday')
    const r2 = store.getState().setCell('r1', 'start', 'not a date')
    expect(r1.ok).toBe(false)
    expect(r2).toEqual({ ok: false, error: 'Enter a valid date as YYYY-MM-DD' })
    expect(cell(store, 'r1', 'start')).toBe('2026-11-09')
    expect(store.getState().errors).toEqual([{ rowId: 'r1', colId: 'start', message: 'Enter a valid date as YYYY-MM-DD' }])
    expect(p.saveCell).not.toHaveBeenCalled()

    // A later valid value clears the error.
    expect(store.getState().setCell('r1', 'start', '2026-11-10')).toEqual({ ok: true })
    expect(store.getState().errors).toEqual([])
  })

  it('stores the validated canonical value', async () => {
    const { store, p } = await loaded()
    store.getState().setCell('r2', 'dur', ' 1w ')
    expect(cell(store, 'r2', 'dur')).toBe('5d')
    store.getState().setCell('r2', 'name', '')
    expect(cell(store, 'r2', 'name')).toBeNull()
    await settled(store)
    expect(p.saveCell).toHaveBeenCalledWith('r2', 'dur', '5d', 0)
  })

  it('rejects unknown rows and columns', async () => {
    const { store } = await loaded()
    expect(store.getState().setCell('nope', 'name', 'x').ok).toBe(false)
    expect(store.getState().setCell('r1', 'nope', 'x').ok).toBe(false)
  })

  it('retries a failing save 3 times, then marks failed and keeps the value', async () => {
    const { store, p } = await loaded()
    p.saveCell.mockRejectedValue(new Error('offline'))
    store.getState().setCell('r1', 'name', 'Dig')
    await settled(store, 'failed')
    expect(p.saveCell).toHaveBeenCalledTimes(4)
    expect(cell(store, 'r1', 'name')).toBe('Dig')
  })

  it('shows unsaved while waiting to retry', async () => {
    vi.useFakeTimers()
    const p = fakePersistence()
    const store = createSheetStore(p)
    await store.getState().load('sh')
    p.saveCell.mockRejectedValue(new Error('offline'))
    store.getState().setCell('r1', 'name', 'Dig')
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getState().saveStatus).toBe('unsaved')
    expect(p.saveCell).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(p.saveCell).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(p.saveCell).toHaveBeenCalledTimes(3)
    expect(store.getState().saveStatus).toBe('unsaved')
    await vi.advanceTimersByTimeAsync(2000)
    expect(p.saveCell).toHaveBeenCalledTimes(4)
    expect(store.getState().saveStatus).toBe('failed')

    // A later edit of that cell starts a fresh queue.
    p.saveCell.mockResolvedValue({ version: 1 })
    store.getState().setCell('r1', 'name', 'Dig deeper')
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getState().saveStatus).toBe('saved')
  })

  it('recovers to saved when a retry succeeds', async () => {
    const { store, p } = await loaded()
    p.saveCell.mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce({ version: 5 })
    store.getState().setCell('r1', 'name', 'Dig')
    await settled(store)
    expect(p.saveCell).toHaveBeenCalledTimes(2)
    expect(store.getState().data!.rows[0].version).toBe(5)
  })

  it('coalesces rapid edits to one cell, latest wins, never out of order', async () => {
    const { store, p } = await loaded()
    const resolvers: ((v: { version: number }) => void)[] = []
    p.saveCell.mockImplementation(() => new Promise((r) => resolvers.push(r)))
    store.getState().setCell('r1', 'name', 'a')
    store.getState().setCell('r1', 'name', 'b')
    store.getState().setCell('r1', 'name', 'c')
    expect(cell(store, 'r1', 'name')).toBe('c')
    expect(p.saveCell).toHaveBeenCalledTimes(1)
    resolvers[0]({ version: 1 })
    await vi.waitFor(() => expect(p.saveCell).toHaveBeenCalledTimes(2))
    resolvers[1]({ version: 2 })
    await settled(store)
    expect(p.saveCell.mock.calls.map((c) => c[2])).toEqual(['a', 'c'])
    // The second save carries the version returned by the first.
    expect(p.saveCell.mock.calls[1][3]).toBe(1)
    expect(store.getState().data!.rows[0].version).toBe(2)
  })

  it('re-runs the schedule when a duration changes', async () => {
    const { store } = await loaded()
    expect(store.getState().setCell('r1', 'dur', '4d')).toEqual({ ok: true })
    const s = store.getState().scheduled
    expect(s.byRow.r1).toMatchObject({ start: '2026-11-09', end: '2026-11-12' })
    expect(s.byRow.r2).toMatchObject({ start: '2026-11-13', end: '2026-11-17' })
    // Scheduled values are derived only; cells are not rewritten.
    expect(cell(store, 'r2', 'start')).toBeUndefined()
  })

  it('treats a blank duration as one day', async () => {
    const { store } = await loaded()
    store.getState().setCell('r1', 'dur', '')
    expect(store.getState().scheduled.byRow.r1).toMatchObject({ start: '2026-11-09', end: '2026-11-09', durationDays: 1 })
  })

  it('rejects editing a rollup column on a parent row', async () => {
    const data = sheetData({
      rows: [rec('r1', 'a0', { start: '2026-11-09' }), rec('c1', 'a0', { start: '2026-11-10' }, 'r1')],
      dependencies: [],
    })
    const { store, p } = await loaded(fakePersistence(data))
    for (const col of ['start', 'dur', 'pct']) {
      expect(store.getState().setCell('r1', col, col === 'start' ? '2026-11-11' : '1').ok).toBe(false)
    }
    expect(cell(store, 'r1', 'start')).toBe('2026-11-09')
    expect(store.getState().setCell('r1', 'status', 'Done')).toEqual({ ok: true })
    await settled(store)
    expect(p.saveCell).toHaveBeenCalledTimes(1)
  })
})

describe('schedule without a start column', () => {
  it('is empty with no errors', async () => {
    const data = sheetData({ columns: columns.filter((c) => c.role !== 'start') })
    const { store } = await loaded(fakePersistence(data))
    expect(store.getState().scheduled).toEqual({ byRow: {}, errors: [], critical: [] })
    store.getState().setCell('r1', 'dur', '5d')
    expect(store.getState().scheduled).toEqual({ byRow: {}, errors: [], critical: [] })
  })
})

describe('rows', () => {
  it('adds a row after another with the same parent and persists it', async () => {
    const data = sheetData({ rows: [rec('p', 'a0', {}), rec('c1', 'a0', {}, 'p'), rec('c2', 'a1', {}, 'p')], dependencies: [] })
    const { store, p } = await loaded(fakePersistence(data))
    const id = store.getState().addRow('c1')
    const row = store.getState().data!.rows.find((r) => r.id === id)!
    expect(row).toMatchObject({ parentId: 'p', cells: {}, version: 0 })
    expect(row.position > 'a0' && row.position < 'a1').toBe(true)
    await settled(store)
    expect(p.insertRow).toHaveBeenCalledWith('sh', row)
  })

  it('appends a row at the end when no afterId is given', async () => {
    const { store } = await loaded()
    const id = store.getState().addRow()
    const rows = store.getState().data!.rows
    expect(rows.find((r) => r.id === id)!.position > 'a1').toBe(true)
  })

  it('indent of the first row is a no-op with no persistence call', async () => {
    const { store, p } = await loaded()
    const before = store.getState().data
    store.getState().indentRow('r1')
    expect(store.getState().data).toBe(before)
    expect(p.saveRowTree).not.toHaveBeenCalled()
    expect(store.getState().saveStatus).toBe('saved')
  })

  it('indent saves only the changed row', async () => {
    const { store, p } = await loaded(fakePersistence(sheetData({ dependencies: [] })))
    store.getState().indentRow('r2')
    expect(store.getState().data!.rows[1].parentId).toBe('r1')
    await settled(store)
    expect(p.saveRowTree).toHaveBeenCalledTimes(1)
    const saved = p.saveRowTree.mock.calls[0] as unknown as [{ id: string; parentId: string | null }[]]
    expect(saved[0]).toEqual([{ id: 'r2', parentId: 'r1', position: expect.any(String) }])

    store.getState().outdentRow('r2')
    expect(store.getState().data!.rows[1].parentId).toBeNull()
    await settled(store)
    expect(p.saveRowTree).toHaveBeenCalledTimes(2)
  })

  it('moves a row', async () => {
    const { store, p } = await loaded()
    store.getState().moveRow('r2', null, null)
    expect(store.getState().data!.rows.find((r) => r.id === 'r2')!.position < 'a0').toBe(true)
    await settled(store)
    expect(p.saveRowTree).toHaveBeenCalledTimes(1)
    store.getState().moveRow('r2', 'r2', null) // invalid: no-op
    expect(p.saveRowTree).toHaveBeenCalledTimes(1)
  })

  it('deleting a row removes its dependencies and records a notice', async () => {
    const data = sheetData({
      rows: [rec('r1', 'a0', { start: '2026-11-09' }), rec('r2', 'a1', {}), rec('r3', 'a2', {}), rec('c', 'a0', {}, 'r2')],
      dependencies: [fs('r1', 'r2'), fs('r1', 'r3'), fs('c', 'r3')],
    })
    const { store, p } = await loaded(fakePersistence(data))
    store.getState().deleteRow('r2')
    const s = store.getState()
    expect(s.data!.rows.map((r) => r.id)).toEqual(['r1', 'r3'])
    expect(s.data!.dependencies).toEqual([fs('r1', 'r3')])
    expect(s.notices).toEqual(['Removed 2 dependencies that referenced deleted rows'])
    await settled(store)
    expect(p.deleteRows).toHaveBeenCalledWith(['r2', 'c'])
    expect(p.saveDependencies).toHaveBeenCalledWith('sh', [fs('r1', 'r3')])
  })

  it('uses the singular notice for one dependency and skips saveDependencies when none change', async () => {
    const { store, p } = await loaded()
    store.getState().deleteRow('r2')
    expect(store.getState().notices).toEqual(['Removed 1 dependency that referenced deleted rows'])
    await settled(store)

    const { store: s2, p: p2 } = await loaded(fakePersistence(sheetData({ dependencies: [] })))
    s2.getState().deleteRow('r2')
    expect(s2.getState().notices).toEqual([])
    await settled(s2)
    expect(p2.deleteRows).toHaveBeenCalledWith(['r2'])
    expect(p2.saveDependencies).not.toHaveBeenCalled()
    expect(p.saveDependencies).toHaveBeenCalledTimes(1)
  })

  it('dismissNotice removes one notice by index', async () => {
    const { store } = await loaded()
    store.setState({ notices: ['a', 'b', 'c'] })
    store.getState().dismissNotice(1)
    expect(store.getState().notices).toEqual(['a', 'c'])
    store.getState().dismissNotice(9)
    expect(store.getState().notices).toEqual(['a', 'c'])
  })
})

describe('dependencies', () => {
  const three = () =>
    sheetData({
      rows: [rec('r1', 'a0', { start: '2026-11-09' }), rec('r2', 'a1', {}), rec('r3', 'a2', {})],
      dependencies: [fs('r2', 'r3')],
    })

  it('rejects a dependency that would create a cycle, naming rows by number', async () => {
    const { store, p } = await loaded(fakePersistence(three()))
    expect(store.getState().addDependency(fs('r3', 'r2'))).toEqual({
      ok: false,
      error: 'Dependency would create a cycle: row 2 -> row 3 -> row 2',
    })
    expect(store.getState().data!.dependencies).toEqual([fs('r2', 'r3')])
    expect(p.saveDependencies).not.toHaveBeenCalled()
  })

  it('rejects unknown, self, duplicate and summary-successor dependencies', async () => {
    const data = three()
    data.rows.push(rec('c', 'a0', {}, 'r3'))
    const { store } = await loaded(fakePersistence(data))
    const add = store.getState().addDependency
    expect(add(fs('zz', 'r2')).ok).toBe(false)
    expect(add(fs('r1', 'r1')).ok).toBe(false)
    const pairTaken = { ok: false, error: 'A dependency between these rows already exists' }
    expect(add(fs('r2', 'r3'))).toEqual(pairTaken)
    // One dependency per pair, whatever its type or lag.
    expect(add({ predecessorId: 'r2', successorId: 'r3', type: 'SS', lagMinutes: 480 })).toEqual(pairTaken)
    expect(add(fs('r1', 'r3'))).toEqual({ ok: false, error: 'Summary rows cannot have predecessors' })
  })

  it('adds a dependency, reschedules and persists the full set', async () => {
    const { store, p } = await loaded(fakePersistence(three()))
    expect(store.getState().addDependency(fs('r1', 'r2'))).toEqual({ ok: true })
    expect(store.getState().scheduled.byRow.r2).toMatchObject({ start: '2026-11-10' })
    await settled(store)
    expect(p.saveDependencies).toHaveBeenCalledWith('sh', [fs('r2', 'r3'), fs('r1', 'r2')])
  })

  it('removes all dependencies between a pair', async () => {
    const data = three()
    data.dependencies.push({ predecessorId: 'r2', successorId: 'r3', type: 'SS', lagMinutes: 0 })
    const { store, p } = await loaded(fakePersistence(data))
    store.getState().removeDependency('r2', 'r3')
    expect(store.getState().data!.dependencies).toEqual([])
    await settled(store)
    expect(p.saveDependencies).toHaveBeenCalledWith('sh', [])
  })
})

describe('save status across overlapping and failed saves', () => {
  it('returns to saved when an edit made during retries is saved after the old value fails', async () => {
    const { store, p } = await loaded()
    let calls = 0
    p.saveCell.mockImplementation(async (_r, _c, _v, version) => {
      calls++
      // The user edits the same cell while the first value is being retried.
      if (calls === 2) expect(store.getState().setCell('r1', 'name', 'new')).toEqual({ ok: true })
      if (calls <= 4) throw new Error('offline')
      return { version: version + 1 }
    })
    store.getState().setCell('r1', 'name', 'old')
    await settled(store)
    expect(p.saveCell.mock.calls.map((c) => c[2])).toEqual(['old', 'old', 'old', 'old', 'new'])
    expect(cell(store, 'r1', 'name')).toBe('new')
  })

  it('stays failed while a different cell is unsaved, even when another save succeeds', async () => {
    const { store, p } = await loaded()
    p.saveCell.mockImplementation(async (_r, c, _v, version) => {
      if (c === 'name') throw new Error('offline')
      return { version: version + 1 }
    })
    store.getState().setCell('r1', 'name', 'x')
    await settled(store, 'failed')
    store.getState().setCell('r1', 'status', 'Done')
    await vi.waitFor(() => expect(p.saveCell).toHaveBeenCalledWith('r1', 'status', 'Done', 0))
    await new Promise((r) => setTimeout(r, 10))
    expect(store.getState().saveStatus).toBe('failed')
  })

  it('clears a failed dependency save once a later dependency save succeeds', async () => {
    const { store, p } = await loaded(fakePersistence(sheetData({ dependencies: [] })))
    p.saveDependencies.mockRejectedValue(new Error('offline'))
    store.getState().addDependency(fs('r1', 'r2'))
    await settled(store, 'failed')
    expect(p.saveDependencies).toHaveBeenCalledTimes(4)
    p.saveDependencies.mockResolvedValue(undefined)
    store.getState().removeDependency('r1', 'r2')
    await settled(store)
    expect(p.saveDependencies).toHaveBeenLastCalledWith('sh', [])
  })
})

describe('new rows', () => {
  it('inserts a new row before saving edits to it, sending the latest value', async () => {
    const { store, p } = await loaded()
    const calls: string[] = []
    let finishInsert!: () => void
    p.insertRow.mockImplementation(
      (_s, row) =>
        new Promise<void>((r) => {
          calls.push(`insert ${row.id} ${JSON.stringify(row.cells)}`)
          finishInsert = r
        }),
    )
    p.saveCell.mockImplementation(async (rowId, colId, value, version) => {
      calls.push(`saveCell ${rowId} ${colId} ${String(value)}`)
      return { version: version + 1 }
    })
    const id = store.getState().addRow('r2')
    // Edits made while the insert is in flight: coalesced, latest wins.
    store.getState().setCell(id, 'name', 'Frame')
    store.getState().setCell(id, 'name', 'Framing')
    expect(p.saveCell).not.toHaveBeenCalled()
    finishInsert()
    await settled(store)
    expect(calls).toEqual([`insert ${id} {}`, `saveCell ${id} name Framing`])
  })

  it('clears failed cells of a new row once its insert succeeds with their values', async () => {
    const { store, p } = await loaded()
    p.insertRow.mockRejectedValue(new Error('offline'))
    const id = store.getState().addRow('r2')
    await settled(store, 'failed')
    store.getState().setCell(id, 'name', 'Frame')
    store.getState().setCell(id, 'status', 'Open')
    await vi.waitFor(() => expect(p.insertRow).toHaveBeenCalledTimes(12))
    await settled(store, 'failed')

    // Network back: editing only name inserts the row with both cells and clears everything.
    p.insertRow.mockResolvedValue(undefined)
    store.getState().setCell(id, 'name', 'Frame 2')
    await settled(store)
    expect(p.insertRow).toHaveBeenLastCalledWith('sh', expect.objectContaining({ id, cells: { name: 'Frame 2', status: 'Open' } }))
    expect(p.saveCell).not.toHaveBeenCalled()
  })

  it('re-queues the insert with current cells after a failed insert, then recovers', async () => {
    const { store, p } = await loaded()
    p.insertRow.mockRejectedValue(new Error('offline'))
    const id = store.getState().addRow('r2')
    await settled(store, 'failed')
    expect(p.insertRow).toHaveBeenCalledTimes(4)

    p.insertRow.mockResolvedValue(undefined)
    store.getState().setCell(id, 'name', 'Frame')
    await settled(store)
    expect(p.insertRow).toHaveBeenCalledTimes(5)
    expect(p.insertRow.mock.calls[4][1]).toMatchObject({ id, parentId: null, cells: { name: 'Frame' } })
    expect(p.saveCell).not.toHaveBeenCalled()

    // Now persisted: further edits use saveCell.
    store.getState().setCell(id, 'name', 'Frame 2')
    await settled(store)
    expect(p.saveCell).toHaveBeenCalledWith(id, 'name', 'Frame 2', 0)
  })

  it('re-queues the insert with the current parent and position after a tree change', async () => {
    const { store, p } = await loaded(fakePersistence(sheetData({ dependencies: [] })))
    p.insertRow.mockRejectedValue(new Error('offline'))
    const id = store.getState().addRow('r2')
    await settled(store, 'failed')
    p.insertRow.mockResolvedValue(undefined)
    store.getState().indentRow(id)
    await settled(store)
    const row = store.getState().data!.rows.find((r) => r.id === id)!
    expect(row.parentId).toBe('r2')
    expect(p.insertRow).toHaveBeenLastCalledWith('sh', expect.objectContaining({ id, parentId: 'r2', position: row.position }))
    expect(p.saveRowTree).not.toHaveBeenCalled()
  })

  it('inserts an unpersisted row before saving a dependency on it', async () => {
    const { store, p } = await loaded()
    const calls: string[] = []
    p.insertRow.mockRejectedValue(new Error('offline'))
    const id = store.getState().addRow('r2')
    await settled(store, 'failed')
    p.insertRow.mockImplementation(async () => void calls.push('insert'))
    p.saveDependencies.mockImplementation(async () => void calls.push('deps'))
    expect(store.getState().addDependency(fs('r2', id))).toEqual({ ok: true })
    await settled(store)
    expect(calls).toEqual(['insert', 'deps'])
  })

  it('clears a failed insert when the row is deleted', async () => {
    const { store, p } = await loaded()
    p.insertRow.mockRejectedValue(new Error('offline'))
    const id = store.getState().addRow('r2')
    await settled(store, 'failed')
    store.getState().deleteRow(id)
    await settled(store)
    expect(p.deleteRows).toHaveBeenCalledWith([id])
  })
})

describe('retryFailed and failedCount', () => {
  it('counts failed changes and re-sends every failed cell with its current value', async () => {
    const { store, p } = await loaded()
    p.saveCell.mockRejectedValue(new Error('offline'))
    store.getState().setCell('r1', 'name', 'A')
    store.getState().setCell('r2', 'name', 'B')
    await vi.waitFor(() => expect(store.getState().failedCount).toBe(2))
    expect(store.getState().saveStatus).toBe('failed')

    p.saveCell.mockImplementation(async (_r, _c, _v, version) => ({ version: version + 1 }))
    p.saveCell.mockClear()
    store.getState().retryFailed()
    await settled(store)
    expect(store.getState().failedCount).toBe(0)
    expect(p.saveCell.mock.calls.map((c) => [c[0], c[1], c[2]]).sort()).toEqual([
      ['r1', 'name', 'A'],
      ['r2', 'name', 'B'],
    ])
  })

  it('re-sends a failed dependency save with the current set', async () => {
    const { store, p } = await loaded(fakePersistence(sheetData({ dependencies: [] })))
    p.saveDependencies.mockRejectedValue(new Error('offline'))
    store.getState().addDependency(fs('r1', 'r2'))
    await settled(store, 'failed')
    p.saveDependencies.mockResolvedValue(undefined)
    store.getState().retryFailed()
    await settled(store)
    expect(p.saveDependencies).toHaveBeenLastCalledWith('sh', [fs('r1', 'r2')])
  })

  it('re-sends failed deletes', async () => {
    const { store, p } = await loaded(fakePersistence(sheetData({ dependencies: [] })))
    p.deleteRows.mockRejectedValue(new Error('offline'))
    store.getState().deleteRow('r2')
    await settled(store, 'failed')
    p.deleteRows.mockResolvedValue(undefined)
    p.deleteRows.mockClear()
    store.getState().retryFailed()
    await settled(store)
    expect(p.deleteRows).toHaveBeenCalledWith(['r2'])
  })

  it('re-sends a failed insert of a new row', async () => {
    const { store, p } = await loaded()
    p.insertRow.mockRejectedValue(new Error('offline'))
    const id = store.getState().addRow('r2')
    await settled(store, 'failed')
    p.insertRow.mockResolvedValue(undefined)
    p.insertRow.mockClear()
    store.getState().retryFailed()
    await settled(store)
    expect(p.insertRow).toHaveBeenCalledWith('sh', expect.objectContaining({ id }))
  })

  it('retryFailed with nothing failed does nothing', async () => {
    const { store, p } = await loaded()
    store.getState().retryFailed()
    await settled(store)
    expect(p.saveCell).not.toHaveBeenCalled()
    expect(store.getState().failedCount).toBe(0)
  })

  it('an edit to a child whose parent insert failed inserts the parent chain first, root first', async () => {
    const { store, p } = await loaded(fakePersistence(sheetData({ dependencies: [] })))
    p.insertRow.mockRejectedValue(new Error('offline'))
    const parent = store.getState().addRow('r2')
    await settled(store, 'failed')
    const inserted: string[] = []
    p.insertRow.mockImplementation(async (_s, row) => void inserted.push(row.id))
    const child = store.getState().addRow(null, parent)
    await settled(store)
    expect(inserted).toEqual([parent, child])
    expect(store.getState().failedCount).toBe(0)
  })

  it('a tree change of a persisted row under a parent whose insert failed inserts that parent first', async () => {
    const { store, p } = await loaded(fakePersistence(sheetData({ dependencies: [] })))
    p.insertRow.mockRejectedValue(new Error('offline'))
    const fresh = store.getState().addRow('r1') // between r1 and r2
    await settled(store, 'failed')
    const calls: string[] = []
    p.insertRow.mockImplementation(async (_s, row) => void calls.push(`insert ${row.id}`))
    p.saveRowTree.mockImplementation(async (...args: unknown[]) => {
      calls.push(`tree ${(args[0] as { id: string }[]).map((r) => r.id).join()}`)
    })
    store.getState().indentRow('r2') // r2 becomes a child of the unpersisted row
    await settled(store)
    expect(store.getState().data!.rows.find((r) => r.id === 'r2')!.parentId).toBe(fresh)
    expect(calls).toEqual([`insert ${fresh}`, 'tree r2'])
  })
})
