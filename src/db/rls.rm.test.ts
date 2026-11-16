// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Resource management tables (0004_resource_management.sql), verified against PGlite with the
// same stand-ins for Supabase's auth schema as rls.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const PERSON_A = 'aaaaaaaa-0000-0000-0000-0000000000a1'
const PROJECT_A = 'aaaaaaaa-0000-0000-0000-0000000000b1'
const SHEET_A = 'aaaaaaaa-0000-0000-0000-0000000000c1'
const PERSON_B = 'bbbbbbbb-0000-0000-0000-0000000000a1'
const PROJECT_B = 'bbbbbbbb-0000-0000-0000-0000000000b1'
const SHEET_B = 'bbbbbbbb-0000-0000-0000-0000000000c1'

const MIGRATIONS = ['0001_schema.sql', '0002_hardening.sql', '0003_columns.sql', '0004_resource_management.sql']
const TABLES = ['rm_people', 'rm_projects', 'rm_assignments', 'rm_views'] as const

let db: PGlite

async function asUser(uid: string | null) {
  await db.exec('RESET ROLE')
  await db.exec('SET ROLE authenticated')
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? ''])
}

async function asAnon() {
  await db.exec('RESET ROLE')
  await db.query(`select set_config('request.jwt.claim.sub', '', false)`)
  await db.exec('SET ROLE anon')
}

async function count(table: string): Promise<number> {
  const r = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)
  return r.rows[0].n
}

async function seed(uid: string, person: string, project: string, sheet: string) {
  await asUser(uid)
  await db.query(`insert into sheets (id, name) values ($1, 'Sheet')`, [sheet])
  await db.query(`insert into rm_people (id, first_name, last_name) values ($1, 'Hilda', 'Wilson')`, [person])
  await db.query(
    `insert into rm_projects (id, name, starts_at, ends_at, project_owner_id, sheet_id)
     values ($1, 'Tower', '2026-11-16', '2026-12-18', $2, $3)`,
    [project, person, sheet],
  )
  await db.query(
    `insert into rm_assignments (project_id, person_id, starts_at, ends_at, allocation_percent)
     values ($1, $2, '2026-11-16', '2026-11-27', 50)`,
    [project, person],
  )
  await db.query(`insert into rm_views (page, name, state) values ('people', 'Mine', '{"sort":"first"}')`)
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create schema auth;
    create role authenticated nologin;
    create role anon nologin;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public to authenticated, anon;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;
    alter default privileges in schema public grant all on tables to anon, authenticated;
  `)
  for (const file of MIGRATIONS) {
    await db.exec(readFileSync(resolve(__dirname, '../../supabase/migrations', file), 'utf8'))
  }
}, 60_000)

afterAll(async () => {
  await db.close()
}, 60_000)

beforeEach(async () => {
  await db.exec('RESET ROLE')
  await db.exec('truncate rm_assignments, rm_projects, rm_people, rm_views, sheets cascade')
  await seed(A, PERSON_A, PROJECT_A, SHEET_A)
  await seed(B, PERSON_B, PROJECT_B, SHEET_B)
}, 30_000)

describe('resource management isolation', () => {
  it('shows each user only their own people, projects, assignments and views', async () => {
    for (const uid of [A, B]) {
      await asUser(uid)
      for (const t of TABLES) expect(await count(t)).toBe(1)
    }
  })

  it('gives anon no access', async () => {
    await asAnon()
    for (const t of TABLES) await expect(db.query(`select * from ${t}`)).rejects.toThrow(/permission denied/i)
  })

  it("rejects an assignment pointing at another user's person or project", async () => {
    await asUser(B)
    await expect(
      db.query(
        `insert into rm_assignments (project_id, person_id, starts_at, ends_at) values ($1, $2, '2026-11-16', '2026-11-17')`,
        [PROJECT_B, PERSON_A],
      ),
    ).rejects.toThrow(/foreign key/i)
    await expect(
      db.query(
        `insert into rm_assignments (project_id, person_id, starts_at, ends_at) values ($1, $2, '2026-11-16', '2026-11-17')`,
        [PROJECT_A, PERSON_B],
      ),
    ).rejects.toThrow(/foreign key/i)
  })

  it("rejects a project owned by another user's person or linked to another user's sheet", async () => {
    await asUser(B)
    await expect(
      db.query(`update rm_projects set project_owner_id = $1 where id = $2`, [PERSON_A, PROJECT_B]),
    ).rejects.toThrow(/row-level security/i)
    await expect(db.query(`update rm_projects set sheet_id = $1 where id = $2`, [SHEET_A, PROJECT_B])).rejects.toThrow(
      /row-level security/i,
    )
  })

  it("makes B's updates and deletes of A's rows affect nothing", async () => {
    await asUser(B)
    for (const t of TABLES) {
      expect((await db.query(`delete from ${t} where owner_id = $1`, [A])).affectedRows).toBe(0)
    }
    await asUser(A)
    for (const t of TABLES) expect(await count(t)).toBe(1)
  })
})

describe('resource management constraints and cascades', () => {
  it('rejects an end before the start and an allocation out of range', async () => {
    await asUser(A)
    await expect(
      db.query(`insert into rm_projects (name, starts_at, ends_at) values ('Bad', '2026-11-20', '2026-11-19')`),
    ).rejects.toThrow(/check/i)
    await expect(
      db.query(
        `insert into rm_assignments (project_id, person_id, starts_at, ends_at, allocation_percent) values ($1, $2, '2026-11-16', '2026-11-17', 0)`,
        [PROJECT_A, PERSON_A],
      ),
    ).rejects.toThrow(/check/i)
  })

  it('deleting a person removes their assignments and clears them as project owner', async () => {
    await asUser(A)
    await db.query(`delete from rm_people where id = $1`, [PERSON_A])
    expect(await count('rm_assignments')).toBe(0)
    const r = await db.query<{ project_owner_id: string | null }>(`select project_owner_id from rm_projects`)
    expect(r.rows[0].project_owner_id).toBeNull()
  })

  it('deleting a project removes its assignments; deleting its sheet only unlinks it', async () => {
    await asUser(A)
    await db.query(`delete from sheets where id = $1`, [SHEET_A])
    const r = await db.query<{ sheet_id: string | null }>(`select sheet_id from rm_projects`)
    expect(r.rows[0].sheet_id).toBeNull()
    await db.query(`delete from rm_projects where id = $1`, [PROJECT_A])
    expect(await count('rm_assignments')).toBe(0)
  })
})
