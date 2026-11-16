import type { SupabaseClient } from '@supabase/supabase-js'
import { generateNKeysBetween } from 'fractional-indexing'
import { addUser, createFakeSupabase, emptyState, FAKE_STORAGE_KEY, type DbRecord, type FakeState, type StorageLike } from '../../e2e/support/fakeSupabase'
import type { TableColumn } from './testSupport'

/** Test helper: the in-memory fake backend with one signed-in user and a few sheets. Only tests import this file. */

export function memoryStorage(state: FakeState): StorageLike & { map: Map<string, string> } {
  const map = new Map([[FAKE_STORAGE_KEY, JSON.stringify(state)]])
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

/** A sheet to seed: columns as [title, type?, options?] and rows of plain cell values. */
export interface SeedSheet {
  name: string
  columns?: TableColumn[]
  rows?: unknown[][]
}

export interface TestBackend {
  client: SupabaseClient
  userId: string
  storage: ReturnType<typeof memoryStorage>
  /** Ids of the seeded sheets, in order. */
  sheetIds: string[]
  /** For each seeded sheet: its column ids and row ids, in order. */
  columnIds: string[][]
  rowIds: string[][]
  /** Reads the raw table rows of the fake database. */
  table(name: string): DbRecord[]
}

let counter = 0
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`

export function testBackend(sheets: (string | SeedSheet)[] = []): TestBackend {
  const state = emptyState()
  const user = addUser(state, 'assets@example.com', 'assets-password')
  state.sessionUserId = user.id
  const own = { owner_id: user.id, workspace_id: user.id }
  const sheetIds: string[] = []
  const columnIds: string[][] = []
  const rowIds: string[][] = []
  sheets.forEach((input, i) => {
    const seed: SeedSheet = typeof input === 'string' ? { name: input } : input
    const id = uuid()
    sheetIds.push(id)
    state.tables.sheets.push({
      id,
      ...own,
      name: seed.name,
      calendar: { workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 },
      dependencies_enabled: false,
      created_at: new Date(2026, 10, i + 1).toISOString(),
    })
    const cols = (seed.columns ?? []).map(([title, type = 'TEXT_NUMBER', options], position) => ({
      id: uuid(), sheet_id: id, ...own, title, type, position, options: options ?? null, system_type: null, role: null, width: null,
    }))
    state.tables.columns.push(...cols)
    columnIds.push(cols.map((c) => c.id))
    const data = seed.rows ?? []
    const positions = data.length > 0 ? generateNKeysBetween(null, null, data.length) : []
    const ids = data.map(() => uuid())
    data.forEach((values, r) =>
      state.tables.rows.push({
        id: ids[r], sheet_id: id, ...own, parent_id: null, position: positions[r], version: 0,
        cells: Object.fromEntries(cols.flatMap((c, j) => (values[j] == null ? [] : [[c.id, values[j]]]))),
      }),
    )
    rowIds.push(ids)
  })
  const storage = memoryStorage(state)
  const client = createFakeSupabase({ storage }) as unknown as SupabaseClient
  return {
    client,
    userId: user.id,
    storage,
    sheetIds,
    columnIds,
    rowIds,
    table: (name) => (JSON.parse(storage.map.get(FAKE_STORAGE_KEY)!) as FakeState).tables[name as keyof FakeState['tables']],
  }
}
