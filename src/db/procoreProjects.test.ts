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

describe('0020_procore_projects', () => {
  it('seeds BKK-03 Bangkok 3, a site offered to the planner', async () => {
    await as.asUser(USER)
    const r = await db.query(`select code, name, is_program, in_planner from procore_projects where code = 'BKK-03'`)
    expect(r.rows).toEqual([{ code: 'BKK-03', name: 'Bangkok 3', is_program: false, in_planner: true }])
  })

  it('0021 adds the data centre program project, offered to the planner ahead of the sites', async () => {
    await as.asUser(USER)
    const r = await db.query(`select code, name, is_program, in_planner from procore_projects where in_planner order by is_program desc, code`)
    expect(r.rows).toEqual([
      { code: 'PRG-DC-01', name: 'Data centre programme', is_program: true, in_planner: true },
      { code: 'BKK-03', name: 'Bangkok 3', is_program: false, in_planner: true },
    ])
  })

  it('rejects a name with a comma', async () => {
    await as.asSuperuser()
    await expect(db.query(`insert into procore_projects (code, name) values ('X', 'A, B')`)).rejects.toThrow()
  })

  it('rejects a malformed code', async () => {
    await as.asSuperuser()
    await expect(db.query(`insert into procore_projects (code, name) values ('bkk 03', 'X')`)).rejects.toThrow()
  })

  it('is read-only for users and closed to anon', async () => {
    await as.asUser(USER)
    await expect(db.query(`insert into procore_projects (code, name) values ('X', 'X')`)).rejects.toThrow()
    await expect(db.query(`update procore_projects set in_planner = false where code = 'BKK-03'`)).rejects.toThrow()
    await as.asAnon()
    await expect(db.query(`select * from procore_projects`)).rejects.toThrow()
  })
})
