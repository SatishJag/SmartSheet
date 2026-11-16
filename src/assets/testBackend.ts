import type { SupabaseClient } from '@supabase/supabase-js'
import { addUser, createFakeSupabase, emptyState, FAKE_STORAGE_KEY, type DbRecord, type FakeState, type StorageLike } from '../../e2e/support/fakeSupabase'

/** Test helper: the in-memory fake backend with one signed-in user and a few sheets. Only tests import this file. */

export function memoryStorage(state: FakeState): StorageLike & { map: Map<string, string> } {
  const map = new Map([[FAKE_STORAGE_KEY, JSON.stringify(state)]])
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

export interface TestBackend {
  client: SupabaseClient
  userId: string
  storage: ReturnType<typeof memoryStorage>
  /** Reads the raw table rows of the fake database. */
  table(name: string): DbRecord[]
}

/** A signed-in user owning sheets with the given names. Sheet ids are `sheet-1`, `sheet-2`, ... as UUID-shaped strings. */
export function testBackend(sheetNames: string[] = []): TestBackend & { sheetIds: string[] } {
  const state = emptyState()
  const user = addUser(state, 'assets@example.com', 'assets-password')
  state.sessionUserId = user.id
  const sheetIds = sheetNames.map((_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)
  sheetNames.forEach((name, i) =>
    state.tables.sheets.push({
      id: sheetIds[i],
      owner_id: user.id,
      workspace_id: user.id,
      name,
      calendar: { workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 },
      dependencies_enabled: false,
      created_at: new Date(2026, 10, i + 1).toISOString(),
    }),
  )
  const storage = memoryStorage(state)
  const client = createFakeSupabase({ storage }) as unknown as SupabaseClient
  return {
    client,
    userId: user.id,
    storage,
    sheetIds,
    table: (name) => (JSON.parse(storage.map.get(FAKE_STORAGE_KEY)!) as FakeState).tables[name as keyof FakeState['tables']],
  }
}
