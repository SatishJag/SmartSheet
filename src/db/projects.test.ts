// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSupabaseLikeDb, roles } from './supabaseTestDb'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// Verified against PGlite (Postgres in WASM), not a live Supabase project (see supabaseTestDb.ts).

const USER = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'

let db: PGlite
let as: ReturnType<typeof roles>

beforeAll(async () => {
  db = await createSupabaseLikeDb()
  as = roles(db)
  await db.query(`insert into auth.users (id) values ($1), ($2)`, [USER, OTHER])
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

  it('0022 renames the key and checks to match the table (0024 adds the length checks)', async () => {
    await as.asSuperuser()
    const r = await db.query<{ conname: string }>(`select conname from pg_constraint where conrelid = 'projects'::regclass and contype in ('p', 'c') order by conname`)
    expect(r.rows.map((x) => x.conname)).toEqual(['projects_code_check', 'projects_code_length', 'projects_name_check', 'projects_name_length', 'projects_pkey'])
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

describe('0024 planner-added projects', () => {
  /** Inserts a project as the signed-in user, with the planner defaults unless overridden. */
  async function add(fields: Record<string, unknown> = {}) {
    const row = { code: 'BKK-04', name: 'Bangkok 4', project_type: 'data-centre', created_by: USER, in_procore: false, is_program: false, in_planner: true, ...fields }
    const cols = Object.keys(row)
    const params = cols.map((_, i) => '$' + String(i + 1)).join(', ')
    await db.query('insert into projects (' + cols.join(', ') + ') values (' + params + ')', Object.values(row))
  }

  it('lets a user add a project as themselves, readable by everyone, with when it was added', async () => {
    await as.asUser(USER)
    await add()
    await as.asUser(OTHER)
    const r = await db.query<{ code: string; created_by: string; in_procore: boolean; created_at: Date | null }>(
      `select code, created_by, in_procore, created_at from projects where code = 'BKK-04'`,
    )
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ code: 'BKK-04', created_by: USER, in_procore: false })
    expect(r.rows[0].created_at).not.toBeNull()
  })

  it.each([
    ['as someone else', { code: 'X-1', created_by: OTHER }],
    ['as nobody', { code: 'X-2', created_by: null }],
    ['as in Procore', { code: 'X-3', in_procore: true }],
    ['as a programme', { code: 'X-4', is_program: true }],
    ['hidden from the planner', { code: 'X-5', in_planner: false }],
    ['with a lower-case code', { code: 'bkk-05' }],
    ['with a code over 20 characters', { code: 'A'.repeat(21) }],
    ['with a name over 80 characters', { code: 'X-6', name: 'N'.repeat(81) }],
    ['with a comma in the name', { code: 'X-7', name: 'Bangkok, 4' }],
    ['with a code that exists', { name: 'Bangkok four' }],
  ])('refuses a project added %s', async (_, fields) => {
    await as.asUser(USER)
    await expect(add(fields)).rejects.toThrow()
  })

  it('accepts a 20-character code and an 80-character name', async () => {
    await as.asUser(USER)
    await add({ code: 'A'.repeat(20), name: 'N'.repeat(80) })
  })

  it('lets nobody change or delete a project, even their own', async () => {
    await as.asUser(USER)
    await expect(db.query(`update projects set name = 'Renamed' where code = 'BKK-04'`)).rejects.toThrow()
    await expect(db.query(`delete from projects where code = 'BKK-04'`)).rejects.toThrow()
    await as.asSuperuser()
    const r = await db.query(`select name from projects where code = 'BKK-04'`)
    expect(r.rows).toEqual([{ name: 'Bangkok 4' }])
  })

  it('keeps the seeded projects with no creator', async () => {
    await as.asSuperuser()
    const r = await db.query(`select count(*)::int as n from projects where created_by is null and code in ('BKK-03', 'PRG-DC-01', 'VIL-01')`)
    expect(r.rows).toEqual([{ n: 3 }])
  })
})
