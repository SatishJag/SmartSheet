// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseLikeDb, roles } from './supabaseTestDb'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// Verified against PGlite (Postgres in WASM), not a live Supabase project (see supabaseTestDb.ts).

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const SHEET = 'aaaaaaaa-0000-0000-0000-0000000000a1'
const SHEET_B = 'bbbbbbbb-0000-0000-0000-0000000000a1'
const ROW = 'aaaaaaaa-0000-0000-0000-0000000000b1'
const RES = 'cccccccc-0000-0000-0000-0000000000c1'
const RES_B = 'dddddddd-0000-0000-0000-0000000000d1'

let db: PGlite
let as: ReturnType<typeof roles>

beforeAll(async () => {
  db = await createSupabaseLikeDb()
  as = roles(db)
}, 60_000)
afterAll(async () => {
  await db.close()
}, 60_000)

beforeEach(async () => {
  await as.asSuperuser()
  await db.exec('delete from assignments; delete from resource_time_off; delete from resources; delete from sheets')
  await as.asUser(A)
  await db.query(`insert into sheets (id, name) values ($1, 'Plan A')`, [SHEET])
  await db.query(`insert into rows (id, sheet_id, position) values ($1, $2, 'a0')`, [ROW, SHEET])
  await db.query(`insert into resources (id, name) values ($1, 'Ada')`, [RES])
  await as.asUser(B)
  await db.query(`insert into sheets (id, name) values ($1, 'Plan B')`, [SHEET_B])
  await db.query(`insert into resources (id, name) values ($1, 'Bob')`, [RES_B])
  await as.asUser(A)
})

const count = async (table: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n
const assignment = (over: Record<string, unknown> = {}) => {
  const v = { sheet: SHEET, row: ROW, res: RES, kind: 'percent', value: 50, start: null, end: null, ...over }
  return db.query(
    `insert into assignments (sheet_id, row_id, resource_id, allocation_kind, allocation_value, start_date, end_date)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [v.sheet, v.row, v.res, v.kind, v.value, v.start, v.end],
  )
}

describe('resources', () => {
  it('stores the defaults: a person with a Monday-Friday 8-hour week, owned by the caller', async () => {
    const r = await db.query<{ kind: string; hours_by_weekday: number[]; skills: string[]; owner_id: string; cost_rate: string }>(
      `select kind, hours_by_weekday, skills, owner_id, cost_rate from resources where id = $1`,
      [RES],
    )
    expect(r.rows[0]).toMatchObject({ kind: 'person', owner_id: A, skills: [] })
    expect(r.rows[0].hours_by_weekday.map(Number)).toEqual([0, 8, 8, 8, 8, 8, 0])
    expect(Number(r.rows[0].cost_rate)).toBe(0)
  })

  it('validates name, kind, department, rate, skills and the weekly capacity', async () => {
    const bad = (sql: string, params: unknown[] = []) => expect(db.query(sql, params)).rejects.toThrow()
    await bad(`insert into resources (name) values ('   ')`)
    await bad(`insert into resources (name) values ($1)`, ['x'.repeat(101)])
    await bad(`insert into resources (name, kind) values ('x', 'robot')`)
    await bad(`insert into resources (name, department) values ('x', '  ')`)
    await bad(`insert into resources (name, cost_rate) values ('x', -1)`)
    await bad(`insert into resources (name, hours_by_weekday) values ('x', '{8,8,8}')`)
    await bad(`insert into resources (name, hours_by_weekday) values ('x', '{0,8,8,8,8,8,25}')`)
    await bad(`insert into resources (name, hours_by_weekday) values ('x', '{0,8,8,8,8,8,-1}')`)
    await bad(`insert into resources (name, hours_by_weekday) values ('x', '{0,8,8,null,8,8,0}')`)
    await bad(`insert into resources (name, skills) values ('x', $1)`, [Array.from({ length: 31 }, (_, i) => `s${i}`)])
    await db.query(`insert into resources (name, kind, department, skills, cost_rate, hours_by_weekday) values ('Crane', 'equipment', 'Civil', '{lift,hoist}', 120.5, '{0,10,10,10,10,4,0}')`)
    expect(await count('resources')).toBe(2)
  })

  it('time off needs a resource of the same owner, an ordered range and sane hours', async () => {
    await db.query(`insert into resource_time_off (resource_id, start_date, end_date, hours, note) values ($1, '2026-12-21', '2027-01-01', 0, 'Leave')`, [RES])
    await db.query(`insert into resource_time_off (resource_id, start_date, end_date, hours) values ($1, '2026-12-24', '2026-12-24', 4)`, [RES])
    await expect(db.query(`insert into resource_time_off (resource_id, start_date, end_date) values ($1, '2026-12-02', '2026-12-01')`, [RES])).rejects.toThrow()
    await expect(db.query(`insert into resource_time_off (resource_id, start_date, end_date, hours) values ($1, '2026-12-01', '2026-12-01', 25)`, [RES])).rejects.toThrow()
    await expect(db.query(`insert into resource_time_off (resource_id, start_date, end_date) values ($1, '2000-01-01', '2020-01-01')`, [RES])).rejects.toThrow()
    await expect(db.query(`insert into resource_time_off (resource_id, start_date, end_date) values ($1, '2026-12-01', '2026-12-01')`, [RES_B])).rejects.toThrow()
    expect(await count('resource_time_off')).toBe(2)
  })

  it('deleting a resource removes its time off and its assignments', async () => {
    await db.query(`insert into resource_time_off (resource_id, start_date, end_date) values ($1, '2026-12-01', '2026-12-02')`, [RES])
    await assignment()
    await db.query(`delete from resources where id = $1`, [RES])
    expect(await count('resource_time_off')).toBe(0)
    expect(await count('assignments')).toBe(0)
  })
})

describe('assignments', () => {
  it('stores an assignment of a resource to a row, owned by the caller', async () => {
    await assignment({ kind: 'hours_per_day', value: 6.5, start: '2026-11-16', end: '2026-11-20' })
    const r = await db.query<{ owner_id: string; allocation_kind: string; allocation_value: string; start_date: string }>(
      `select owner_id, allocation_kind, allocation_value, start_date::text from assignments`,
    )
    expect(r.rows[0]).toMatchObject({ owner_id: A, allocation_kind: 'hours_per_day', allocation_value: '6.50', start_date: '2026-11-16' })
  })

  it('allows each kind only up to its ceiling, and only positive values', async () => {
    await assignment({ kind: 'percent', value: 1000, row: ROW })
    await db.exec('delete from assignments')
    await expect(assignment({ kind: 'percent', value: 1001 })).rejects.toThrow()
    await expect(assignment({ kind: 'hours_per_day', value: 24.5 })).rejects.toThrow()
    await expect(assignment({ kind: 'hours_per_week', value: 169 })).rejects.toThrow()
    await expect(assignment({ kind: 'total_hours', value: 100001 })).rejects.toThrow()
    await expect(assignment({ kind: 'percent', value: 0 })).rejects.toThrow()
    await expect(assignment({ kind: 'percent', value: -5 })).rejects.toThrow()
    await expect(assignment({ kind: 'weeks' })).rejects.toThrow()
    await assignment({ kind: 'total_hours', value: 100000 })
    expect(await count('assignments')).toBe(1)
  })

  it('one assignment per task and resource; own dates must be ordered', async () => {
    await assignment()
    await expect(assignment({ value: 80 })).rejects.toThrow()
    await db.exec('delete from assignments')
    await expect(assignment({ start: '2026-11-20', end: '2026-11-16' })).rejects.toThrow()
    await assignment({ start: '2026-11-16' }) // one end may be open
    expect(await count('assignments')).toBe(1)
  })

  it('survives deleting the row (history), but goes with the sheet', async () => {
    await assignment()
    await db.query(`delete from rows where id = $1`, [ROW])
    expect(await count('assignments')).toBe(1)
    await db.query(`delete from sheets where id = $1`, [SHEET])
    expect(await count('assignments')).toBe(0)
  })
})

describe('access', () => {
  it("another user can neither read nor write a user's resources and assignments", async () => {
    await assignment()
    await db.query(`insert into resource_time_off (resource_id, start_date, end_date) values ($1, '2026-12-01', '2026-12-02')`, [RES])
    await as.asUser(B)
    expect(await count('resources')).toBe(1) // only Bob
    expect(await count('assignments')).toBe(0)
    expect(await count('resource_time_off')).toBe(0)
    await expect(db.query(`insert into assignments (sheet_id, row_id, resource_id, allocation_kind, allocation_value) values ($1, $2, $3, 'percent', 50)`, [SHEET, ROW, RES])).rejects.toThrow()
    await expect(db.query(`insert into assignments (sheet_id, row_id, resource_id, allocation_kind, allocation_value) values ($1, $2, $3, 'percent', 50)`, [SHEET, ROW, RES_B])).rejects.toThrow() // A's sheet
    expect((await db.query(`update resources set name = 'Hijacked' where id = $1 returning id`, [RES])).rows).toEqual([])
    expect((await db.query(`delete from resources where id = $1 returning id`, [RES])).rows).toEqual([])
    await as.asUser(A)
    expect((await db.query<{ name: string }>(`select name from resources where id = $1`, [RES])).rows[0].name).toBe('Ada')
    expect(await count('assignments')).toBe(1)
  })

  it('a user cannot assign their own task to another user’s resource, nor create rows owned by someone else', async () => {
    await expect(assignment({ res: RES_B })).rejects.toThrow()
    await expect(db.query(`insert into resources (name, owner_id) values ('Fake', $1)`, [B])).rejects.toThrow()
    await expect(db.query(`insert into resources (name, workspace_id) values ('Fake', $1)`, [B])).rejects.toThrow()
  })

  it('anon has no access', async () => {
    await as.asAnon()
    for (const t of ['resources', 'resource_time_off', 'assignments']) {
      await expect(db.query(`select * from ${t}`)).rejects.toThrow(/permission denied/)
    }
    await expect(db.query(`insert into resources (name) values ('x')`)).rejects.toThrow(/permission denied/)
  })

  it('row-level security is on for all three tables', async () => {
    await as.asSuperuser()
    const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname in ('resources', 'resource_time_off', 'assignments') order by relname`,
    )
    expect(r.rows.map((x) => x.relrowsecurity)).toEqual([true, true, true])
  })
})
