import { describe, expect, it, vi } from 'vitest'
import { defaultCalendar } from '../engine/calendar'
import type { SchedDep } from '../engine/schedule'
import type { Column } from '../model/validate'
import type { Persistence, RowRecord, SheetData } from '../store/persistence'
import { createSheetStore } from '../store/sheetStore'
import { dayLoad, dayNumber, type Assignment, type Resource } from './engine'
import type { ResourcePersistence } from './persistence'
import { allTasks, createResourceStore, loadModel } from './resourceStore'
import { taskFactsFromSheet } from './taskFacts'
import { person, task } from './testkit'

function memory(initial: { resources?: Resource[]; assignments?: Assignment[]; sheets?: Record<string, { name: string; tasks: ReturnType<typeof task>[] }> } = {}) {
  let resources = [...(initial.resources ?? [])]
  let assignments = [...(initial.assignments ?? [])]
  const sheets = initial.sheets ?? {}
  const p: ResourcePersistence = {
    loadResources: vi.fn(async () => resources),
    saveResource: vi.fn(async (r: Resource) => {
      resources = resources.some((x) => x.id === r.id) ? resources.map((x) => (x.id === r.id ? r : x)) : [...resources, r]
    }),
    deleteResource: vi.fn(async (id: string) => {
      resources = resources.filter((r) => r.id !== id)
      assignments = assignments.filter((a) => a.resourceId !== id)
    }),
    loadAssignments: vi.fn(async (sheetId?: string) => assignments.filter((a) => !sheetId || a.sheetId === sheetId)),
    saveAssignment: vi.fn(async (a: Assignment) => {
      assignments = assignments.some((x) => x.id === a.id) ? assignments.map((x) => (x.id === a.id ? a : x)) : [...assignments, a]
    }),
    deleteAssignment: vi.fn(async (id: string) => {
      assignments = assignments.filter((a) => a.id !== id)
    }),
    loadSheetTasks: vi.fn(async (sheetId: string) => ({ sheetId, sheetName: sheets[sheetId].name, tasks: sheets[sheetId].tasks })),
  }
  return p
}

const full = { kind: 'percent', value: 100 } as const

describe('resource store', () => {
  it('loads resources and assignments, then the tasks of the sheets that have assignments', async () => {
    const p = memory({
      resources: [person('a')],
      assignments: [
        { id: '1', sheetId: 's1', rowId: 't1', resourceId: 'a', allocation: full, startDate: null, endDate: null },
        { id: '2', sheetId: 's2', rowId: 'u1', resourceId: 'a', allocation: full, startDate: null, endDate: null },
      ],
      sheets: {
        s1: { name: 'Tower A', tasks: [{ ...task('t1', '2026-11-16', '2026-11-17'), sheetId: 's1' }] },
        s2: { name: 'Tower B', tasks: [{ ...task('u1', '2026-11-18', '2026-11-18'), sheetId: 's2' }] },
      },
    })
    const store = createResourceStore(p)
    expect(store.getState().loaded).toBe(false)
    await store.getState().loadAll()
    const s = store.getState()
    expect(s.loaded).toBe(true)
    expect(s.tasksLoading).toBe(false)
    expect(s.loadError).toBeNull()
    expect(s.sheetNames).toEqual({ s1: 'Tower A', s2: 'Tower B' })
    expect(allTasks(s)).toHaveLength(2)
    const m = loadModel(s)
    expect(dayLoad(m, 'a', dayNumber('2026-11-16')).assigned).toBe(8)
    expect(dayLoad(m, 'a', dayNumber('2026-11-18')).assigned).toBe(8)
    expect(loadModel(s)).toBe(m) // memoised
  })

  it('a second loadAll while one is running shares it', async () => {
    const p = memory({ resources: [person('a')] })
    const store = createResourceStore(p)
    await Promise.all([store.getState().loadAll(), store.getState().loadAll()])
    expect(p.loadResources).toHaveBeenCalledTimes(1)
  })

  it('does not fetch a live sheet and uses its tasks instead', async () => {
    const p = memory({
      resources: [person('a')],
      assignments: [{ id: '1', sheetId: 's1', rowId: 't1', resourceId: 'a', allocation: full, startDate: null, endDate: null }],
      sheets: { s1: { name: 'Stale copy', tasks: [{ ...task('t1', '2026-11-16', '2026-11-16'), sheetId: 's1' }] } },
    })
    const store = createResourceStore(p)
    store.getState().setLiveSheet('s1', 'Tower A', [{ ...task('t1', '2026-11-23', '2026-11-23'), sheetId: 's1' }])
    await store.getState().loadAll()
    expect(p.loadSheetTasks).not.toHaveBeenCalled()
    expect(store.getState().sheetNames.s1).toBe('Tower A')
    expect(dayLoad(loadModel(store.getState()), 'a', dayNumber('2026-11-23')).assigned).toBe(8)
  })

  it('reports sheets that failed to load without losing the rest', async () => {
    const p = memory({
      resources: [person('a')],
      assignments: [
        { id: '1', sheetId: 's1', rowId: 't1', resourceId: 'a', allocation: full, startDate: null, endDate: null },
        { id: '2', sheetId: 's2', rowId: 'u1', resourceId: 'a', allocation: full, startDate: null, endDate: null },
      ],
      sheets: { s1: { name: 'Ok', tasks: [{ ...task('t1', '2026-11-16', '2026-11-16'), sheetId: 's1' }] } },
    })
    const store = createResourceStore(p)
    await store.getState().loadAll()
    expect(store.getState().loadError).toMatch(/Could not load 1 sheet/)
    expect(allTasks(store.getState())).toHaveLength(1)
  })

  it('surfaces a failing load', async () => {
    const p = memory()
    p.loadResources = vi.fn(async () => {
      throw new Error('boom')
    })
    const store = createResourceStore(p)
    await store.getState().loadAll()
    expect(store.getState()).toMatchObject({ loadError: 'boom', loaded: false })
  })

  it('creates, edits and deletes resources; sorted by name; failures leave state alone', async () => {
    const p = memory()
    const store = createResourceStore(p)
    expect(await store.getState().saveResource(person('z', { name: 'Zed' }))).toEqual({ ok: true })
    await store.getState().saveResource(person('a', { name: 'Ada' }))
    expect(store.getState().resources.map((r) => r.name)).toEqual(['Ada', 'Zed'])
    await store.getState().saveResource(person('z', { name: 'Aaron' }))
    expect(store.getState().resources.map((r) => r.name)).toEqual(['Aaron', 'Ada'])

    p.saveResource = vi.fn(async () => {
      throw new Error('nope')
    })
    expect(await store.getState().saveResource(person('b', { name: 'Bob' }))).toEqual({ ok: false, error: 'nope' })
    expect(store.getState().resources).toHaveLength(2)

    expect(await store.getState().deleteResource('a')).toEqual({ ok: true })
    expect(store.getState().resources.map((r) => r.id)).toEqual(['z'])
  })

  it('assign creates, then updates the same pair in place; deleting a resource drops its assignments', async () => {
    const p = memory({ resources: [person('a'), person('b')] })
    const store = createResourceStore(p)
    await store.getState().loadAll()
    await store.getState().assign({ sheetId: 's1', rowId: 't1', resourceId: 'a', allocation: { kind: 'percent', value: 50 } })
    await store.getState().assign({ sheetId: 's1', rowId: 't1', resourceId: 'b', allocation: full })
    await store.getState().assign({ sheetId: 's1', rowId: 't1', resourceId: 'a', allocation: { kind: 'hours_per_day', value: 3 }, startDate: '2026-11-16', endDate: '2026-11-17' })
    const s = store.getState()
    expect(s.assignments).toHaveLength(2)
    expect(s.assignments.find((a) => a.resourceId === 'a')).toMatchObject({ allocation: { kind: 'hours_per_day', value: 3 }, startDate: '2026-11-16', endDate: '2026-11-17' })
    expect(p.saveAssignment).toHaveBeenCalledTimes(3)
    const id = s.assignments.find((a) => a.resourceId === 'b')!.id
    expect(await store.getState().unassign(id)).toEqual({ ok: true })
    expect(store.getState().assignments).toHaveLength(1)
    await store.getState().deleteResource('a')
    expect(store.getState().assignments).toEqual([])
  })

  it('a failed assign changes nothing', async () => {
    const p = memory({ resources: [person('a')] })
    p.saveAssignment = vi.fn(async () => {
      throw new Error('too much')
    })
    const store = createResourceStore(p)
    await store.getState().loadAll()
    expect(await store.getState().assign({ sheetId: 's1', rowId: 't1', resourceId: 'a', allocation: full })).toEqual({ ok: false, error: 'too much' })
    expect(store.getState().assignments).toEqual([])
  })
})

// ---- assignments follow a task whose dates move (real sheet store) ----------------------------------

const columns: Column[] = [
  { id: 'name', title: 'Task', type: 'TEXT_NUMBER' },
  { id: 'start', title: 'Start', type: 'DATE', role: 'start' },
  { id: 'dur', title: 'Duration', type: 'DURATION', role: 'duration' },
]
const rec = (id: string, position: string, cells: Record<string, unknown>, parentId: string | null = null): RowRecord => ({ id, parentId, position, cells, version: 0 })
const fs = (predecessorId: string, successorId: string): SchedDep => ({ predecessorId, successorId, type: 'FS', lagMinutes: 0 })

function sheetPersistence(data: SheetData): Persistence {
  return {
    loadSheet: vi.fn(async () => structuredClone(data)),
    saveCell: vi.fn(async (_r: string, _c: string, _v: unknown, version: number) => ({ version: version + 1 })),
    insertRow: vi.fn(async () => {}),
    saveRowTree: vi.fn(async () => {}),
    saveDependencies: vi.fn(async () => {}),
    deleteRows: vi.fn(async () => {}),
    saveSheetSettings: vi.fn(async () => {}),
    insertColumn: vi.fn(async () => {}),
    updateColumn: vi.fn(async () => {}),
    saveColumnOrder: vi.fn(async () => {}),
    deleteColumn: vi.fn(async () => {}),
    saveColumnCells: vi.fn(async () => {}),
    loadBaselineRows: vi.fn(async () => []),
    saveBaseline: vi.fn(),
    deleteBaseline: vi.fn(async () => {}),
  } as unknown as Persistence
}

describe('taskFactsFromSheet and following the task', () => {
  const data: SheetData = {
    sheet: { id: 'sh', name: 'Tower', ownerId: 'u', workspaceId: 'u', calendar: defaultCalendar, dependenciesEnabled: true },
    columns,
    rows: [
      rec('phase', 'a0', { name: 'Phase 1' }),
      rec('t1', 'a1', { name: 'Excavate', start: '2026-11-16', dur: '2d' }, 'phase'),
      rec('t2', 'a2', { name: 'Pour', dur: '3d' }, 'phase'),
      rec('t3', 'a3', { name: 'Cure', start: '2026-11-16', dur: '1d' }),
      rec('m', 'a4', { name: 'Handover', start: '2026-11-20', dur: '0d' }),
    ],
    dependencies: [fs('t1', 't2')],
  }

  it('lists leaf tasks only, with dates, float and critical flags', () => {
    const facts = taskFactsFromSheet(data)
    expect(facts.map((t) => t.rowId)).toEqual(['t1', 't2', 't3', 'm'])
    const t2 = facts.find((t) => t.rowId === 't2')!
    expect(t2).toMatchObject({ sheetId: 'sh', name: 'Pour', start: '2026-11-18', end: '2026-11-20', durationDays: 3, critical: true, totalFloat: 0 })
    const t3 = facts.find((t) => t.rowId === 't3')!
    expect(t3.totalFloat).toBeGreaterThan(0)
    expect(t3.critical).toBe(false)
    expect(facts.find((t) => t.rowId === 'm')!.durationDays).toBe(0)
  })

  it('has no float when dependencies are off', () => {
    const facts = taskFactsFromSheet({ ...data, sheet: { ...data.sheet, dependenciesEnabled: false } })
    expect(facts.every((t) => t.totalFloat === null && !t.critical)).toBe(true)
  })

  it('a sheet without a start column has no tasks', () => {
    expect(taskFactsFromSheet({ ...data, columns: columns.filter((c) => c.role !== 'start') })).toEqual([])
  })

  it('moving a task in the sheet moves its assignment hours', async () => {
    const sheet = createSheetStore(sheetPersistence(data), { retryDelaysMs: [0, 0, 0] })
    await sheet.getState().load('sh')
    const store = createResourceStore(memory({ resources: [person('a')] }))
    await store.getState().loadAll()
    await store.getState().assign({ sheetId: 'sh', rowId: 't1', resourceId: 'a', allocation: { kind: 'percent', value: 50 } })
    const push = () => store.getState().setLiveSheet('sh', 'Tower', taskFactsFromSheet(sheet.getState().data!, sheet.getState().scheduled))

    push()
    let m = loadModel(store.getState())
    expect(dayLoad(m, 'a', dayNumber('2026-11-16')).assigned).toBe(4)
    expect(dayLoad(m, 'a', dayNumber('2026-11-23')).assigned).toBe(0)

    // Push the task a week later: its Start is a typed date and nothing drives it.
    expect(sheet.getState().setCell('t1', 'start', '2026-11-23')).toEqual({ ok: true })
    push()
    m = loadModel(store.getState())
    expect(dayLoad(m, 'a', dayNumber('2026-11-16')).assigned).toBe(0)
    expect(dayLoad(m, 'a', dayNumber('2026-11-23')).assigned).toBe(4)
    expect(dayLoad(m, 'a', dayNumber('2026-11-24')).assigned).toBe(4)
    expect(dayLoad(m, 'a', dayNumber('2026-11-25')).assigned).toBe(0)

    // And a longer duration spreads the same percentage over more days.
    expect(sheet.getState().setCell('t1', 'dur', '4d')).toEqual({ ok: true })
    push()
    m = loadModel(store.getState())
    expect(dayLoad(m, 'a', dayNumber('2026-11-26')).assigned).toBe(4)
  })

  it('a deleted task stops carrying load but its assignment is kept', async () => {
    const sheet = createSheetStore(sheetPersistence(data), { retryDelaysMs: [0, 0, 0] })
    await sheet.getState().load('sh')
    const store = createResourceStore(memory({ resources: [person('a')] }))
    await store.getState().loadAll()
    await store.getState().assign({ sheetId: 'sh', rowId: 't3', resourceId: 'a', allocation: full })
    sheet.getState().deleteRow('t3')
    store.getState().setLiveSheet('sh', 'Tower', taskFactsFromSheet(sheet.getState().data!, sheet.getState().scheduled))
    const m = loadModel(store.getState())
    expect(dayLoad(m, 'a', dayNumber('2026-11-16')).assigned).toBe(0)
    expect(m.skipped).toHaveLength(1)
    expect(store.getState().assignments).toHaveLength(1)
  })
})
