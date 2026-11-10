// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// PGlite boots a WASM Postgres; under a loaded full-suite run (many parallel jsdom
// files) that can exceed vitest's 10 s default hook timeout. Scoped to this file only.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// NOTE: verified against PGlite (Postgres in WASM), not a real Supabase instance.
// Real Supabase provides the `auth` schema, `auth.uid()` and the `authenticated`
// role; the setup below recreates just those so the migration can run unchanged.

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const SHEET = 'aaaaaaaa-0000-0000-0000-000000000001'
const COL = 'aaaaaaaa-0000-0000-0000-000000000002'
const PARENT = 'aaaaaaaa-0000-0000-0000-000000000003'
const CHILD = 'aaaaaaaa-0000-0000-0000-000000000004'
const DEP = 'aaaaaaaa-0000-0000-0000-000000000005'

const TABLES = ['sheets', 'columns', 'rows', 'dependencies'] as const

let db: PGlite

async function asUser(uid: string | null) {
  await db.exec('RESET ROLE')
  await db.exec('SET ROLE authenticated')
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? ''])
}

async function asSuperuser() {
  await db.exec('RESET ROLE')
  await db.query(`select set_config('request.jwt.claim.sub', '', false)`)
}

async function count(table: string): Promise<number> {
  const r = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)
  return r.rows[0].n
}

async function seedAsA() {
  await asUser(A)
  await db.query(`insert into sheets (id, name) values ($1, 'Sheet A')`, [SHEET])
  await db.query(
    `insert into columns (id, sheet_id, title, type, position) values ($1, $2, 'Task', 'TEXT_NUMBER', 0)`,
    [COL, SHEET],
  )
  await db.query(`insert into rows (id, sheet_id, position) values ($1, $2, 'a0')`, [PARENT, SHEET])
  await db.query(`insert into rows (id, sheet_id, parent_id, position) values ($1, $2, $3, 'a0')`, [
    CHILD,
    SHEET,
    PARENT,
  ])
  await db.query(
    `insert into dependencies (id, sheet_id, predecessor_row_id, successor_row_id, type)
     values ($1, $2, $3, $4, 'FS')`,
    [DEP, SHEET, PARENT, CHILD],
  )
}

beforeAll(async () => {
  db = new PGlite()
  // What real Supabase already provides:
  await db.exec(`
    create schema auth;
    create role authenticated nologin;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public to authenticated;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
  `)
  const migration = readFileSync(resolve(__dirname, '../../supabase/migrations/0001_schema.sql'), 'utf8')
  await db.exec(migration)
}, 60_000)

afterAll(async () => {
  await db.close()
}, 60_000)

beforeEach(async () => {
  await asSuperuser()
  await db.exec('truncate sheets cascade')
  await seedAsA()
}, 30_000)

describe('isolation between users', () => {
  it('lets user A see their own data', async () => {
    await asUser(A)
    expect(await count('sheets')).toBe(1)
    expect(await count('columns')).toBe(1)
    expect(await count('rows')).toBe(2)
    expect(await count('dependencies')).toBe(1)
  })

  it('hides every table from user B', async () => {
    await asUser(B)
    for (const t of TABLES) expect(await count(t)).toBe(0)
  })

  it('rejects user B inserting a sheet owned by A', async () => {
    await asUser(B)
    await expect(
      db.query(`insert into sheets (name, owner_id) values ('Sneaky', $1)`, [A]),
    ).rejects.toThrow(/row-level security/i)
  })

  it("rejects user B inserting a row into A's sheet even with owner_id = B", async () => {
    await asUser(B)
    await expect(
      db.query(`insert into rows (sheet_id, position, owner_id) values ($1, 'b0', $2)`, [SHEET, B]),
    ).rejects.toThrow(/row-level security/i)
  })

  it("rejects user B adding a column or dependency to A's sheet", async () => {
    await asUser(B)
    await expect(
      db.query(
        `insert into columns (sheet_id, title, type, position, owner_id) values ($1, 'x', 'TEXT_NUMBER', 1, $2)`,
        [SHEET, B],
      ),
    ).rejects.toThrow(/row-level security/i)
    await expect(
      db.query(
        `insert into dependencies (sheet_id, predecessor_row_id, successor_row_id, type, owner_id)
         values ($1, $2, $3, 'FS', $4)`,
        [SHEET, CHILD, PARENT, B],
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('makes user B updates and deletes affect 0 rows', async () => {
    await asUser(B)
    const upd = await db.query(`update rows set cells = '{"x":1}' where sheet_id = $1`, [SHEET])
    expect(upd.affectedRows).toBe(0)
    const del = await db.query(`delete from rows where sheet_id = $1`, [SHEET])
    expect(del.affectedRows).toBe(0)
    const delSheet = await db.query(`delete from sheets where id = $1`, [SHEET])
    expect(delSheet.affectedRows).toBe(0)
    await asUser(A)
    expect(await count('rows')).toBe(2)
    expect(await count('sheets')).toBe(1)
  })

  it('rejects user A handing a row to user B by changing owner_id', async () => {
    await asUser(A)
    await expect(
      db.query(`update rows set owner_id = $1 where id = $2`, [B, CHILD]),
    ).rejects.toThrow(/row-level security/i)
  })

  it('returns nothing and rejects inserts when no identity is set', async () => {
    await asUser(null)
    for (const t of TABLES) expect(await count(t)).toBe(0)
    // owner_id defaults to auth.uid() = null, violating NOT NULL
    await expect(db.query(`insert into sheets (name) values ('anon')`)).rejects.toThrow()
    await expect(
      db.query(`insert into sheets (name, owner_id) values ('anon', $1)`, [A]),
    ).rejects.toThrow(/row-level security/i)
  })
})

describe('constraints', () => {
  it('rejects a dependency type outside FS/SS/FF/SF', async () => {
    await asUser(A)
    await expect(
      db.query(
        `insert into dependencies (sheet_id, predecessor_row_id, successor_row_id, type)
         values ($1, $2, $3, 'XX')`,
        [SHEET, CHILD, PARENT],
      ),
    ).rejects.toThrow(/check constraint/i)
  })

  it('rejects a self-dependency', async () => {
    await asUser(A)
    await expect(
      db.query(
        `insert into dependencies (sheet_id, predecessor_row_id, successor_row_id, type)
         values ($1, $2, $2, 'FS')`,
        [SHEET, CHILD],
      ),
    ).rejects.toThrow(/check constraint/i)
  })

  it('rejects a column with an unknown type', async () => {
    await asUser(A)
    await expect(
      db.query(`insert into columns (sheet_id, title, type, position) values ($1, 't', 'NOPE', 1)`, [SHEET]),
    ).rejects.toThrow(/check constraint/i)
  })

  it('rejects a column with an unknown role', async () => {
    await asUser(A)
    await expect(
      db.query(
        `insert into columns (sheet_id, title, type, position, role) values ($1, 't', 'DATE', 1, 'bogus')`,
        [SHEET],
      ),
    ).rejects.toThrow(/check constraint/i)
  })

  it('accepts a column with a valid role', async () => {
    await asUser(A)
    await db.query(
      `insert into columns (sheet_id, title, type, position, role) values ($1, 'Start', 'DATE', 1, 'start')`,
      [SHEET],
    )
    expect(await count('columns')).toBe(2)
  })
})

describe('cascades', () => {
  it('deleting a sheet removes its columns, rows and dependencies', async () => {
    await asUser(A)
    await db.query(`delete from sheets where id = $1`, [SHEET])
    for (const t of TABLES) expect(await count(t)).toBe(0)
  })

  it('deleting a parent row removes its children (and their dependencies)', async () => {
    await asUser(A)
    await db.query(`delete from rows where id = $1`, [PARENT])
    expect(await count('rows')).toBe(0)
    expect(await count('dependencies')).toBe(0)
    expect(await count('sheets')).toBe(1)
  })
})

describe('defaults', () => {
  it('fills owner, workspace, calendar, flags and version', async () => {
    await asUser(A)
    const s = await db.query<{
      owner_id: string
      workspace_id: string
      dependencies_enabled: boolean
      calendar: unknown
      created_at: unknown
    }>(
      `select owner_id, workspace_id, dependencies_enabled, calendar, created_at from sheets where id = $1`,
      [SHEET],
    )
    const sheet = s.rows[0]
    expect(sheet.owner_id).toBe(A)
    expect(sheet.workspace_id).toBe(A)
    expect(sheet.dependencies_enabled).toBe(false)
    expect(sheet.calendar).toEqual({ workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 })
    expect(sheet.created_at).toBeTruthy()

    const r = await db.query<{ version: number; cells: unknown; owner_id: string; workspace_id: string }>(
      `select version, cells, owner_id, workspace_id from rows where id = $1`,
      [PARENT],
    )
    expect(r.rows[0].version).toBe(0)
    expect(r.rows[0].cells).toEqual({})
    expect(r.rows[0].owner_id).toBe(A)
    expect(r.rows[0].workspace_id).toBe(A)

    const d = await db.query<{ lag_minutes: number }>(`select lag_minutes from dependencies where id = $1`, [DEP])
    expect(d.rows[0].lag_minutes).toBe(0)
  })
})
