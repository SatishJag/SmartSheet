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

describe('projects (0020, 0021, 0022)', () => {
  it('seeds BKK-03 Bangkok 3, a site offered to the planner', async () => {
    await as.asUser(USER)
    const r = await db.query(`select code, name, is_program, in_planner from projects where code = 'BKK-03'`)
    expect(r.rows).toEqual([{ code: 'BKK-03', name: 'Bangkok 3', is_program: false, in_planner: true }])
  })

  it('0021 adds the data centre program project, offered to the planner ahead of the sites', async () => {
    await as.asUser(USER)
    const r = await db.query(`select code, name, is_program, in_planner from projects where in_planner and project_type = 'data-centre' order by is_program desc, code`)
    expect(r.rows).toEqual([
      { code: 'PRG-DC-01', name: 'Data centre programme', is_program: true, in_planner: true },
      { code: 'BKK-03', name: 'Bangkok 3', is_program: false, in_planner: true },
    ])
  })

  it('0022 renames the table and keeps the Procore projects as linked data centre projects', async () => {
    await as.asUser(USER)
    const r = await db.query(`select code, project_type, in_procore from projects where code in ('PRG-DC-01', 'BKK-03') order by code`)
    expect(r.rows).toEqual([
      { code: 'BKK-03', project_type: 'data-centre', in_procore: true },
      { code: 'PRG-DC-01', project_type: 'data-centre', in_procore: true },
    ])
  })

  it('0022 adds the four sample property projects, not in Procore', async () => {
    await as.asUser(USER)
    const r = await db.query(
      `select code, name from projects where project_type = 'properties' and not in_procore and not is_program and in_planner order by code`,
    )
    expect(r.rows).toEqual([
      { code: 'INF-01', name: 'Sample infrastructure' },
      { code: 'MC-01', name: 'Sample master community' },
      { code: 'TWR-01', name: 'Sample tower' },
      { code: 'VIL-01', name: 'Sample villa' },
    ])
  })

  it('rejects an unknown project type', async () => {
    await as.asSuperuser()
    await expect(db.query(`insert into projects (code, name, project_type) values ('X', 'X', 'moon')`)).rejects.toThrow()
  })

  it('procore_projects is gone', async () => {
    await as.asSuperuser()
    await expect(db.query(`select * from procore_projects`)).rejects.toThrow()
  })

  it('rejects a name with a comma', async () => {
    await as.asSuperuser()
    await expect(db.query(`insert into projects (code, name) values ('X', 'A, B')`)).rejects.toThrow()
  })

  it('rejects a malformed code', async () => {
    await as.asSuperuser()
    await expect(db.query(`insert into projects (code, name) values ('bkk 03', 'X')`)).rejects.toThrow()
  })

  it('is read-only for users and closed to anon', async () => {
    await as.asUser(USER)
    await expect(db.query(`insert into projects (code, name) values ('X', 'X')`)).rejects.toThrow()
    await expect(db.query(`update projects set in_planner = false where code = 'BKK-03'`)).rejects.toThrow()
    await as.asAnon()
    await expect(db.query(`select * from projects`)).rejects.toThrow()
  })
})
