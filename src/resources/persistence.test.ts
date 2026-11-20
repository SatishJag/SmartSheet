// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { addUser, createFakeSupabase, emptyState, FAKE_STORAGE_KEY, type StorageLike } from '../../e2e/support/fakeSupabase'
import type { Assignment, Resource } from './engine'
import { assignmentFromDb, assignmentToDb, resourceFromDb, resourceToDb, supabaseResourcePersistence } from './persistence'

function memoryStorage(json: string): StorageLike {
  const map = new Map([[FAKE_STORAGE_KEY, json]])
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

const COLS = [
  { id: 'c-name', title: 'Task', type: 'TEXT_NUMBER', position: 0 },
  { id: 'c-start', title: 'Start', type: 'DATE', position: 1, role: 'start' },
  { id: 'c-dur', title: 'Duration', type: 'DURATION', position: 2, role: 'duration' },
]

/** Two signed-in users in one fake backend; user A owns a sheet with two tasks. */
function seeded() {
  const state = emptyState()
  const a = addUser(state, 'a@example.com', 'password-a')
  const b = addUser(state, 'b@example.com', 'password-b')
  state.sessionUserId = a.id
  const own = { owner_id: a.id, workspace_id: a.id }
  const sheetId = crypto.randomUUID()
  state.tables.sheets.push({ id: sheetId, ...own, name: 'Tower', calendar: { workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 }, dependencies_enabled: false, created_at: new Date().toISOString() })
  for (const c of COLS) state.tables.columns.push({ id: c.id + sheetId, sheet_id: sheetId, ...own, title: c.title, type: c.type, position: c.position, options: null, system_type: null, role: c.role ?? null, width: null })
  const rows = [crypto.randomUUID(), crypto.randomUUID()]
  rows.forEach((id, i) =>
    state.tables.rows.push({ id, sheet_id: sheetId, ...own, parent_id: null, position: `a${i}`, cells: { ['c-name' + sheetId]: `Task ${i + 1}`, ['c-start' + sheetId]: '2026-11-16', ['c-dur' + sheetId]: '3d' }, version: 0 }),
  )
  const storage = memoryStorage(JSON.stringify(state))
  const client = createFakeSupabase({ storage }) as unknown as SupabaseClient
  return { client, storage, sheetId, rows, a, b }
}

const ada: Resource = {
  id: crypto.randomUUID(),
  name: 'Ada',
  kind: 'person',
  department: 'Electrical',
  skills: ['Wiring'],
  costRate: 55.5,
  hoursByWeekday: [0, 8, 8, 8, 8, 4, 0],
  timeOff: [{ start: '2026-12-21', end: '2027-01-01', hours: 0, note: 'Leave' }],
}

describe('mappers', () => {
  it('round-trips a resource and an assignment', () => {
    const db = { ...resourceToDb(ada), owner_id: 'u', workspace_id: 'u' }
    expect(resourceFromDb(db, [{ id: 't', resource_id: ada.id, start_date: '2026-12-21', end_date: '2027-01-01', hours: '0.00', note: 'Leave' }])).toEqual(ada)
    const a: Assignment = { id: 'x', sheetId: 's', rowId: 'r', resourceId: 'p', allocation: { kind: 'hours_per_day', value: 6.5 }, startDate: '2026-11-16', endDate: null }
    expect(assignmentFromDb({ ...assignmentToDb(a), allocation_value: '6.50' })).toEqual(a)
  })

  it('reads numeric values that arrive as strings and blank departments as null', () => {
    const r = resourceFromDb({ id: 'r', name: 'X', kind: 'role', department: null, skills: null, cost_rate: '12.50', hours_by_weekday: ['0', '7.5', '7.5', '7.5', '7.5', '7.5', '0'] })
    expect(r).toMatchObject({ costRate: 12.5, skills: [], hoursByWeekday: [0, 7.5, 7.5, 7.5, 7.5, 7.5, 0] })
    expect(resourceToDb({ ...ada, department: '  ' }).department).toBeNull()
  })
})

describe('supabaseResourcePersistence (against the fake backend)', () => {
  it('saves and loads a resource with its time off, and updates it in place', async () => {
    const { client } = seeded()
    const p = supabaseResourcePersistence(client)
    await p.saveResource(ada)
    expect(await p.loadResources()).toEqual([ada])
    const changed: Resource = { ...ada, name: 'Ada L.', timeOff: [{ start: '2027-02-01', end: '2027-02-02', hours: 4 }] }
    await p.saveResource(changed)
    const [back, ...rest] = await p.loadResources()
    expect(rest).toEqual([])
    expect(back).toEqual(changed)
  })

  it('deleting a resource removes it and its assignments', async () => {
    const { client, sheetId, rows } = seeded()
    const p = supabaseResourcePersistence(client)
    await p.saveResource(ada)
    await p.saveAssignment({ id: crypto.randomUUID(), sheetId, rowId: rows[0], resourceId: ada.id, allocation: { kind: 'percent', value: 50 }, startDate: null, endDate: null })
    expect(await p.loadAssignments(sheetId)).toHaveLength(1)
    await p.deleteResource(ada.id)
    expect(await p.loadResources()).toEqual([])
    expect(await p.loadAssignments()).toEqual([])
  })

  it('saves, updates and deletes an assignment; loads per sheet or all', async () => {
    const { client, sheetId, rows } = seeded()
    const p = supabaseResourcePersistence(client)
    await p.saveResource(ada)
    const a: Assignment = { id: crypto.randomUUID(), sheetId, rowId: rows[0], resourceId: ada.id, allocation: { kind: 'percent', value: 50 }, startDate: null, endDate: null }
    await p.saveAssignment(a)
    await p.saveAssignment({ ...a, allocation: { kind: 'total_hours', value: 12 }, startDate: '2026-11-17', endDate: '2026-11-18' })
    expect(await p.loadAssignments()).toEqual([{ ...a, allocation: { kind: 'total_hours', value: 12 }, startDate: '2026-11-17', endDate: '2026-11-18' }])
    expect(await p.loadAssignments('other-sheet')).toEqual([])
    await p.deleteAssignment(a.id)
    expect(await p.loadAssignments()).toEqual([])
  })

  it('refuses invalid data the way the database does', async () => {
    const { client, sheetId, rows } = seeded()
    const p = supabaseResourcePersistence(client)
    await expect(p.saveResource({ ...ada, name: '  ' })).rejects.toThrow()
    await expect(p.saveResource({ ...ada, hoursByWeekday: [8, 8, 8] })).rejects.toThrow()
    await p.saveResource(ada)
    const base: Assignment = { id: crypto.randomUUID(), sheetId, rowId: rows[0], resourceId: ada.id, allocation: { kind: 'percent', value: 50 }, startDate: null, endDate: null }
    await expect(p.saveAssignment({ ...base, allocation: { kind: 'percent', value: 2000 } })).rejects.toThrow()
    await expect(p.saveAssignment({ ...base, startDate: '2026-11-20', endDate: '2026-11-16' })).rejects.toThrow()
    await expect(p.saveAssignment({ ...base, resourceId: crypto.randomUUID() })).rejects.toThrow()
    await p.saveAssignment(base)
    await expect(p.saveAssignment({ ...base, id: crypto.randomUUID() })).rejects.toThrow() // one per task and resource
  })

  it('another user sees nothing of the first user’s resources or assignments', async () => {
    const { client, storage, sheetId, rows, b } = seeded()
    const p = supabaseResourcePersistence(client)
    await p.saveResource(ada)
    await p.saveAssignment({ id: crypto.randomUUID(), sheetId, rowId: rows[0], resourceId: ada.id, allocation: { kind: 'percent', value: 50 }, startDate: null, endDate: null })
    const state = JSON.parse(storage.getItem(FAKE_STORAGE_KEY)!)
    state.sessionUserId = b.id
    storage.setItem(FAKE_STORAGE_KEY, JSON.stringify(state))
    expect(await p.loadResources()).toEqual([])
    expect(await p.loadAssignments()).toEqual([])
  })

  it('an assignment outlives its deleted task but not its deleted sheet', async () => {
    const { client, sheetId, rows } = seeded()
    const p = supabaseResourcePersistence(client)
    await p.saveResource(ada)
    await p.saveAssignment({ id: crypto.randomUUID(), sheetId, rowId: rows[0], resourceId: ada.id, allocation: { kind: 'percent', value: 50 }, startDate: null, endDate: null })
    await client.from('rows').delete().eq('id', rows[0])
    expect(await p.loadAssignments()).toHaveLength(1)
    await client.from('sheets').delete().eq('id', sheetId)
    expect(await p.loadAssignments()).toEqual([])
  })

  it('loads a sheet as tasks with dates and the sheet name', async () => {
    const { client, sheetId, rows } = seeded()
    const p = supabaseResourcePersistence(client)
    const s = await p.loadSheetTasks(sheetId)
    expect(s.sheetName).toBe('Tower')
    expect(s.tasks.map((t) => [t.rowId, t.name, t.start, t.end, t.durationDays])).toEqual([
      [rows[0], 'Task 1', '2026-11-16', '2026-11-18', 3],
      [rows[1], 'Task 2', '2026-11-16', '2026-11-18', 3],
    ])
  })
})
