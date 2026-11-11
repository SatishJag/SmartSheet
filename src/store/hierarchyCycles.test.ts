import { describe, expect, it } from 'vitest'
import { COL, fsDep, makeRow, makeSheetData, makeTestStore } from '../test/fixtures'

// Fixture: 1 r-site (parent of 2 r-survey and 3 r-clear), 4 r-found. Deps: 2 -> 3, 3 -> 4.

/** Two top-level rows A (row 1) and B (row 2), plus C (row 3), with the given dependencies. */
const flat = (deps = [fsDep('a', 'b')]) =>
  makeSheetData({
    rows: [
      makeRow('a', 'a0', { [COL.task]: 'A', [COL.start]: '2026-11-09', [COL.duration]: '1d' }),
      makeRow('b', 'a1', { [COL.task]: 'B', [COL.duration]: '1d' }),
      makeRow('c', 'a2', { [COL.task]: 'C', [COL.start]: '2026-11-09', [COL.duration]: '1d' }),
    ],
    dependencies: deps,
  })

const parentOf = (store: Awaited<ReturnType<typeof makeTestStore>>['store'], id: string) =>
  store.getState().data!.rows.find((r) => r.id === id)!.parentId

describe('dependencies between a task and its own parent or sub-task', () => {
  it('a predecessor edit naming the row\'s own parent is rejected, by row number, and changes nothing', async () => {
    const { store } = await makeTestStore()
    const before = store.getState().data!.dependencies
    expect(store.getState().setCell('r-survey', COL.predecessors, '1')).toEqual({
      ok: false,
      error: 'A task cannot depend on its own parent or sub-task (row 1 -> row 2)',
    })
    expect(store.getState().data!.dependencies).toBe(before)
    expect(store.getState().errors).toEqual([
      { rowId: 'r-survey', colId: COL.predecessors, message: 'A task cannot depend on its own parent or sub-task (row 1 -> row 2)' },
    ])
  })

  it('addDependency from a parent to its sub-task is rejected', async () => {
    const { store } = await makeTestStore()
    expect(store.getState().addDependency(fsDep('r-site', 'r-clear'))).toEqual({
      ok: false,
      error: 'A task cannot depend on its own parent or sub-task (row 1 -> row 3)',
    })
  })

  it('a longer cycle through a parent is rejected too', async () => {
    // 4 depends on 1 (the parent of 2), and 2 would depend on 4: 2 -> (rolls up into) 1 -> 4 -> 2.
    const { store } = await makeTestStore(makeSheetData({ dependencies: [fsDep('r-site', 'r-found')] }))
    const r = store.getState().setCell('r-survey', COL.predecessors, '4')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/^A task cannot depend on its own parent or sub-task \(row \d( -> row \d)+\)$/)
  })

  it('ordinary dependencies still work', async () => {
    const { store } = await makeTestStore()
    expect(store.getState().setCell('r-found', COL.predecessors, '2')).toEqual({ ok: true })
  })
})

describe('tree actions that would create a hierarchy cycle', () => {
  it('indenting a successor under its predecessor is a no-op with a notice', async () => {
    const { store, persistence } = await makeTestStore(flat())
    store.getState().indentRow('b')
    expect(parentOf(store, 'b')).toBeNull()
    expect(store.getState().notices).toEqual(["Can't indent: row 2 depends on row 1, which would become its parent"])
    expect(persistence.saveRowTree).not.toHaveBeenCalled()
  })

  it('indenting a predecessor under its successor is a no-op: the successor cannot become a summary row', async () => {
    const { store } = await makeTestStore(flat([fsDep('b', 'a')]))
    store.getState().indentRow('b')
    expect(parentOf(store, 'b')).toBeNull()
    expect(store.getState().notices).toEqual([
      "Can't indent: row 1 has predecessors, and summary rows cannot have predecessors",
    ])
  })

  it('moving a row under its own successor (a cycle once it rolls up) is refused', async () => {
    // A -> C, then C -> B: moving A under B makes B's dates depend on A while A ... -> B.
    const { store } = await makeTestStore(flat([fsDep('a', 'c'), fsDep('c', 'b')]))
    store.getState().moveRow('b', null, 'a')
    expect(parentOf(store, 'b')).toBeNull()
    expect(store.getState().notices).toHaveLength(1)
    expect(store.getState().notices[0]).toMatch(/^Can't move: /)
  })

  it('moving a row under its predecessor is a no-op with a notice', async () => {
    const { store } = await makeTestStore(flat([fsDep('a', 'c')]))
    store.getState().moveRow('c', null, 'a')
    expect(parentOf(store, 'c')).toBeNull()
    expect(store.getState().notices).toEqual(["Can't move: row 3 depends on row 1, which would become its parent"])
  })

  it('unrelated indents, moves and outdents still apply', async () => {
    const { store } = await makeTestStore(flat([fsDep('a', 'c')]))
    store.getState().indentRow('c') // C under B: no dependency between them
    expect(parentOf(store, 'c')).toBe('b')
    store.getState().outdentRow('c')
    expect(parentOf(store, 'c')).toBeNull()
    store.getState().moveRow('b', null, 'a') // no dependency between A and B
    expect(parentOf(store, 'b')).toBe('a')
    expect(store.getState().notices).toEqual([])
  })

  it('outdenting a sub-task that has dependencies is allowed (outdent never adds a parent link)', async () => {
    const { store } = await makeTestStore()
    store.getState().outdentRow('r-clear')
    expect(parentOf(store, 'r-clear')).toBeNull()
    expect(store.getState().notices).toEqual([])
  })

  it('tree actions are not checked against dependencies when dependencies are disabled', async () => {
    const base = flat()
    const { store } = await makeTestStore({ ...base, sheet: { ...base.sheet, dependenciesEnabled: false } })
    store.getState().indentRow('b')
    expect(parentOf(store, 'b')).toBe('a')
  })
})

describe('scheduler messages name rows by number', () => {
  it('maps raw row ids in scheduled errors to "row N"', async () => {
    // Loaded data can hold a cycle the store would never create.
    const { store } = await makeTestStore(flat([fsDep('a', 'b'), fsDep('b', 'a'), fsDep('b', 'c')]))
    const messages = store.getState().scheduled.errors.map((e) => e.message)
    expect(messages).toContain('Dependency cycle: row 1 -> row 2 -> row 1')
    expect(messages).toContain('Depends on a row in a dependency cycle')
    expect(messages.filter((m) => m.startsWith('Dependency cycle'))).toEqual([
      'Dependency cycle: row 1 -> row 2 -> row 1',
      'Dependency cycle: row 1 -> row 2 -> row 1',
    ])
  })

  it('maps "Predecessor <id> could not be scheduled"', async () => {
    const data = makeSheetData({
      rows: [makeRow('x', 'a0', { [COL.task]: 'X' }), makeRow('y', 'a1', { [COL.task]: 'Y' })],
      dependencies: [fsDep('x', 'y')],
    })
    const { store } = await makeTestStore(data)
    expect(store.getState().scheduled.errors).toContainEqual({ rowId: 'y', message: 'Predecessor row 1 could not be scheduled' })
  })
})
