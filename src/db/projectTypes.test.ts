// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSupabaseLikeDb, roles } from './supabaseTestDb'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// Verified against PGlite (Postgres in WASM), not a live Supabase project (see supabaseTestDb.ts).

const USER = '11111111-1111-1111-1111-111111111111'

let db: PGlite
let as: ReturnType<typeof roles>

beforeAll(async () => {
  db = await createSupabaseLikeDb()
  as = roles(db)
}, 60_000)
afterAll(async () => {
  await db.close()
}, 60_000)

describe('0011_project_types', () => {
  it('seeds Data centre and Properties, readable by a signed-in user', async () => {
    await as.asUser(USER)
    const r = await db.query<{ id: string }>(`select id from project_types order by position`)
    expect(r.rows.map((x) => x.id)).toEqual(['data-centre', 'properties'])
  })

  it('offers LLE procurement under both, and every listed project type exists', async () => {
    await as.asUser(USER)
    const lle = await db.query<{ project_types: string[] }>(`select project_types from schedule_types where id = 'lle-procurement'`)
    expect(lle.rows[0].project_types).toEqual(['data-centre', 'properties'])
    const unknown = await db.query(
      `select s.id, p from schedule_types s, unnest(s.project_types) p where p not in (select id from project_types)`,
    )
    expect(unknown.rows).toEqual([])
  })

  it('is read-only for users and closed to anon', async () => {
    await as.asUser(USER)
    await expect(db.query(`insert into project_types (id, name) values ('x', 'X')`)).rejects.toThrow()
    await as.asAnon()
    await expect(db.query(`select * from project_types`)).rejects.toThrow()
  })
})
