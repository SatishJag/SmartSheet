// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { addUser, createFakeSupabase, emptyState, FAKE_STORAGE_KEY, type DbRecord, type StorageLike } from '../../e2e/support/fakeSupabase'
import { supabasePersistence } from './persistence'

function memoryStorage(json: string): StorageLike {
  const map = new Map([[FAKE_STORAGE_KEY, json]])
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

/** A signed-in user owning one sheet with `rows` rows and a chain of `deps` dependencies. */
function seeded(rows: number, deps: number) {
  const state = emptyState()
  const user = addUser(state, 'pager@example.com', 'pager-password')
  state.sessionUserId = user.id
  const own = { owner_id: user.id, workspace_id: user.id }
  const sheetId = crypto.randomUUID()
  state.tables.sheets.push({
    id: sheetId,
    ...own,
    name: 'Big',
    calendar: { workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 },
    dependencies_enabled: true,
    created_at: new Date().toISOString(),
  })
  const rowIds = Array.from({ length: rows }, () => crypto.randomUUID())
  rowIds.forEach((id, i) =>
    state.tables.rows.push({ id, sheet_id: sheetId, ...own, parent_id: null, position: `a${i}`, cells: {}, version: 0 } as DbRecord),
  )
  for (let i = 0; i < deps; i++) {
    state.tables.dependencies.push({
      id: crypto.randomUUID(),
      sheet_id: sheetId,
      ...own,
      predecessor_row_id: rowIds[i],
      successor_row_id: rowIds[i + 1],
      type: 'FS',
      lag_minutes: 0,
    })
  }
  const client = createFakeSupabase({ storage: memoryStorage(JSON.stringify(state)) }) as unknown as SupabaseClient
  return { client, sheetId, rowIds }
}

describe('supabasePersistence.loadSheet paging', () => {
  it('loads every row and dependency past the 1000-row response cap', async () => {
    const { client, sheetId, rowIds } = seeded(2500, 1200)
    const data = await supabasePersistence(client).loadSheet(sheetId)
    expect(data.rows).toHaveLength(2500)
    expect(new Set(data.rows.map((r) => r.id))).toEqual(new Set(rowIds))
    expect(data.dependencies).toHaveLength(1200)
  })

  it('loads exactly 1000 rows (a full first page then an empty one)', async () => {
    const { client, sheetId } = seeded(1000, 0)
    expect((await supabasePersistence(client).loadSheet(sheetId)).rows).toHaveLength(1000)
  })
})
