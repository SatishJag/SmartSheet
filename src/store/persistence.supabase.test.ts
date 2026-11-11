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
function seeded(rows: number, deps: number, extra: [number, number, string][] = []) {
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
  for (const [p, s, type] of extra) {
    state.tables.dependencies.push({
      id: crypto.randomUUID(),
      sheet_id: sheetId,
      ...own,
      predecessor_row_id: rowIds[p],
      successor_row_id: rowIds[s],
      type,
      lag_minutes: 0,
    })
  }
  const client = createFakeSupabase({ storage: memoryStorage(JSON.stringify(state)) }) as unknown as SupabaseClient
  return { client, sheetId, rowIds }
}

type Call = { table: string; method: string; args: unknown[] }

/** Wraps the fake client to record builder calls and optionally fail the next N deletes. */
function instrument(client: SupabaseClient) {
  const calls: Call[] = []
  const ctl = { failDeletes: 0 }
  const wrapped = {
    auth: client.auth,
    from(table: string) {
      const target = client.from(table) as unknown as Record<string | symbol, unknown>
      const proxy: unknown = new Proxy(target, {
        get(o, p) {
          const v = Reflect.get(o, p)
          if (typeof v !== 'function' || p === 'then') return typeof v === 'function' ? v.bind(o) : v
          return (...args: unknown[]) => {
            calls.push({ table, method: String(p), args })
            if (p === 'delete' && ctl.failDeletes > 0) {
              ctl.failDeletes--
              const failed = { in: () => failed, eq: () => failed, then: (f: (r: unknown) => unknown) => Promise.resolve(f({ data: null, error: { message: 'delete boom' } })) }
              return failed
            }
            const r = (v as (...a: unknown[]) => unknown).apply(o, args)
            return r === o ? proxy : r
          }
        },
      })
      return proxy
    },
  }
  return { client: wrapped as unknown as SupabaseClient, calls, ctl }
}

async function dbDeps(client: SupabaseClient, sheetId: string) {
  const { data } = await client.from('dependencies').select('predecessor_row_id, successor_row_id, type, lag_minutes').eq('sheet_id', sheetId)
  return (data as { predecessor_row_id: string; successor_row_id: string; type: string; lag_minutes: number }[])
    .map((d) => `${d.predecessor_row_id}>${d.successor_row_id}:${d.type}:${d.lag_minutes}`)
    .sort()
}

describe('supabasePersistence.saveDependencies (diff-based)', () => {
  const fs = (p: string, s: string, type: 'FS' | 'SS' = 'FS', lagMinutes = 0) => ({ predecessorId: p, successorId: s, type, lagMinutes })

  it('upserts only new or changed pairs and deletes only removed ones', async () => {
    const { client: raw, sheetId, rowIds: r } = seeded(10, 3) // r0>r1, r1>r2, r2>r3
    const { client, calls } = instrument(raw)
    const p = supabasePersistence(client)
    await p.loadSheet(sheetId)
    calls.length = 0

    // keep r0>r1, change r1>r2 to SS, remove r2>r3, add r5>r6
    await p.saveDependencies(sheetId, [fs(r[0], r[1]), fs(r[1], r[2], 'SS'), fs(r[5], r[6])])
    const upsert = calls.find((c) => c.method === 'upsert')!
    expect((upsert.args[0] as { predecessor_row_id: string }[]).map((d) => d.predecessor_row_id).sort()).toEqual([r[1], r[5]].sort())
    expect(upsert.args[1]).toEqual({ onConflict: 'sheet_id,predecessor_row_id,successor_row_id' })
    expect(calls.filter((c) => c.method === 'delete')).toHaveLength(1)
    expect(await dbDeps(raw, sheetId)).toEqual([`${r[0]}>${r[1]}:FS:0`, `${r[1]}>${r[2]}:SS:0`, `${r[5]}>${r[6]}:FS:0`].sort())

    // Saving the same set again writes nothing.
    calls.length = 0
    await p.saveDependencies(sheetId, [fs(r[0], r[1]), fs(r[1], r[2], 'SS'), fs(r[5], r[6])])
    expect(calls.filter((c) => c.method === 'upsert' || c.method === 'delete')).toEqual([])
  })

  it('deletes removed dependencies in chunks of at most 100 ids', async () => {
    const { client: raw, sheetId } = seeded(260, 250)
    const { client, calls } = instrument(raw)
    const p = supabasePersistence(client)
    await p.loadSheet(sheetId)
    calls.length = 0
    await p.saveDependencies(sheetId, [])
    const sizes = calls.filter((c) => c.method === 'in').map((c) => (c.args[1] as unknown[]).length)
    expect(sizes).toEqual([100, 100, 50])
    expect(await dbDeps(raw, sheetId)).toEqual([])
  })

  it('a failed delete then a retry ends with exactly the desired set and no duplicates', async () => {
    const { client: raw, sheetId, rowIds: r } = seeded(10, 3)
    const { client, ctl } = instrument(raw)
    const p = supabasePersistence(client)
    await p.loadSheet(sheetId)
    const desired = [fs(r[0], r[1], 'SS', 480), fs(r[7], r[8])]
    ctl.failDeletes = 1
    await expect(p.saveDependencies(sheetId, desired)).rejects.toThrow('delete boom')
    await p.saveDependencies(sheetId, desired)
    await p.saveDependencies(sheetId, desired)
    expect(await dbDeps(raw, sheetId)).toEqual([`${r[0]}>${r[1]}:SS:480`, `${r[7]}>${r[8]}:FS:0`].sort())
  })

  it('works for a sheet that was never loaded (reads the persisted set first)', async () => {
    const { client, sheetId, rowIds: r } = seeded(5, 2)
    await supabasePersistence(client).saveDependencies(sheetId, [fs(r[3], r[4])])
    expect(await dbDeps(client, sheetId)).toEqual([`${r[3]}>${r[4]}:FS:0`])
  })

  it('dedupes dependencies by pair on load', async () => {
    // Older data written before the pair key existed: seeded straight into the fake's state.
    const { client, sheetId, rowIds: r } = seeded(5, 0, [
      [0, 1, 'FS'],
      [0, 1, 'SS'],
    ])
    const data = await supabasePersistence(client).loadSheet(sheetId)
    expect(data.dependencies).toHaveLength(1)
    expect(data.dependencies[0]).toMatchObject({ predecessorId: r[0], successorId: r[1] })
  })
})

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
