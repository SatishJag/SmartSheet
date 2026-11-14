// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistorySummary } from '../planner/types'
import { createSupabaseLikeDb, roles } from './supabaseTestDb'

// PGlite boots a WASM Postgres; give it room under a loaded full-suite run (see rls.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// The planner's history library (0004_planner_history.sql); the LLE seed (0005) has its own file.
// Verified against PGlite, not a real Supabase instance. Runs after every migration, as in production.

const USER = '11111111-1111-1111-1111-111111111111'
const TABLES = ['schedule_types', 'activity_catalog', 'history_projects', 'history_activities'] as const
const LLE = 'lle-procurement' // seeded by 0005; used here only as "another schedule type"

let db: PGlite
let as: ReturnType<typeof roles>

beforeAll(async () => {
  db = await createSupabaseLikeDb()
  as = roles(db)
}, 60_000)

afterAll(async () => {
  await db.close()
}, 60_000)

async function count(table: string, where = 'true', params: unknown[] = []): Promise<number> {
  const r = await db.query<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, params)
  return r.rows[0].n
}

async function summary(type: string, equipment: string | null = null): Promise<HistorySummary> {
  const r = await db.query<{ s: HistorySummary }>(`select planner_history_summary($1, $2) as s`, [type, equipment])
  return r.rows[0].s
}

/**
 * A small hand-made dataset under its own schedule type ('test'), as the service role would load it.
 * Activity A (with actual days per project):  p1 10, p2 20, p3 30, p4 40, p5 50  (pumps: p1..p3)
 * Activity B: p1 3, p2 4 (only two projects have it).
 */
async function seedTestType(opts: { realProject?: boolean } = {}) {
  await as.asSuperuser()
  await db.exec(`
    delete from history_projects where schedule_type = 'test';
    delete from activity_catalog where schedule_type = 'test';
    delete from schedule_types where id = 'test';
    insert into schedule_types (id, name, description) values ('test', 'Test type', 'For tests');
    insert into activity_catalog (schedule_type, code, name, phase, sequence, default_links, default_days, is_target) values
      ('test', 'A', 'Activity A', 'P1', 1, '[]', 5, false),
      ('test', 'B', 'Activity B', 'P1', 2, '[{"from":"A","type":"FS","lagDays":0}]', 2, false),
      ('test', 'T', 'Target', 'P2', 3, '[{"from":"B","type":"FS","lagDays":0}]', 0, true);
  `)
  const projects: [string, string, boolean][] = [
    ['00000000-0000-4000-8000-000000000001', 'Pump', true],
    ['00000000-0000-4000-8000-000000000002', 'Pump', true],
    ['00000000-0000-4000-8000-000000000003', 'Pump', true],
    ['00000000-0000-4000-8000-000000000004', 'Valve', true],
    ['00000000-0000-4000-8000-000000000005', 'Valve', !opts.realProject],
  ]
  for (const [id, equipment, sample] of projects) {
    await db.query(
      `insert into history_projects (id, schedule_type, equipment_type, equipment_name, is_sample)
       values ($1, 'test', $2, $2 || ' unit', $3)`,
      [id, equipment, sample],
    )
  }
  const acts: [number, string, number][] = [
    [1, 'A', 10], [2, 'A', 20], [3, 'A', 30], [4, 'A', 40], [5, 'A', 50],
    [1, 'B', 3], [2, 'B', 4],
  ]
  for (const [p, code, days] of acts) {
    await db.query(
      `insert into history_activities (project_id, schedule_type, code, actual_days) values ($1, 'test', $2, $3)`,
      [projects[p - 1][0], code, days],
    )
  }
}

describe('planner_history_summary', () => {
  beforeEach(() => seedTestType(), 30_000)

  it('computes n, p50, p80, min and max per activity, p-values rounded UP to whole days', async () => {
    await as.asUser(USER)
    const s = await summary('test')
    expect(s).toEqual({
      scheduleType: 'test',
      equipmentType: null,
      projectCount: 5,
      sampleOnly: true,
      stats: [
        // A: percentile_cont(0.5) = 30, (0.8) = 42 (40 + 0.2*10); exact values stay as they are.
        { code: 'A', n: 5, p50: 30, p80: 42, min: 10, max: 50 },
        // B: (0.5) = 3.5 -> 4, (0.8) = 3.8 -> 4.
        { code: 'B', n: 2, p50: 4, p80: 4, min: 3, max: 4 },
      ],
    })
  })

  it('filters by equipment type', async () => {
    await as.asUser(USER)
    const pumps = await summary('test', 'Pump')
    expect(pumps.equipmentType).toBe('Pump')
    expect(pumps.projectCount).toBe(3)
    // A over 10, 20, 30: p50 20, p80 = 20 + 0.6*10 = 26.
    expect(pumps.stats).toEqual([
      { code: 'A', n: 3, p50: 20, p80: 26, min: 10, max: 30 },
      { code: 'B', n: 2, p50: 4, p80: 4, min: 3, max: 4 },
    ])
    const valves = await summary('test', 'Valve')
    expect(valves.projectCount).toBe(2)
    // A over 40, 50: p50 45, p80 48; no B.
    expect(valves.stats).toEqual([{ code: 'A', n: 2, p50: 45, p80: 48, min: 40, max: 50 }])
  })

  it('returns an empty summary for an unknown equipment or schedule type', async () => {
    await as.asUser(USER)
    expect(await summary('test', 'Crane')).toEqual({
      scheduleType: 'test',
      equipmentType: 'Crane',
      projectCount: 0,
      sampleOnly: false,
      stats: [],
    })
    expect((await summary('nope')).projectCount).toBe(0)
  })

  it('sets sampleOnly only when every project behind the numbers is sample data', async () => {
    await seedTestType({ realProject: true })
    await as.asUser(USER)
    expect((await summary('test')).sampleOnly).toBe(false)
    expect((await summary('test', 'Valve')).sampleOnly).toBe(false)
    expect((await summary('test', 'Pump')).sampleOnly).toBe(true)
  })

  it('rounds p-values up without floating-point surprises on exact values', async () => {
    await as.asSuperuser()
    // 0.8 * (n - 1) for n = 6 is 4 in exact arithmetic: p80 must be the 5th value, 15, not 16.
    await db.exec(`delete from history_projects where schedule_type = 'test'`)
    for (let i = 0; i < 6; i++) {
      const id = `00000000-0000-4000-8000-00000000010${i}`
      await db.query(
        `insert into history_projects (id, schedule_type, equipment_type, equipment_name, is_sample) values ($1, 'test', 'Pump', 'p', true)`,
        [id],
      )
      await db.query(`insert into history_activities (project_id, schedule_type, code, actual_days) values ($1, 'test', 'A', $2)`, [
        id,
        [11, 12, 13, 14, 15, 16][i],
      ])
    }
    await as.asUser(USER)
    expect((await summary('test')).stats).toEqual([{ code: 'A', n: 6, p50: 14, p80: 15, min: 11, max: 16 }])
  })
})

describe('constraints', () => {
  beforeEach(() => seedTestType(), 30_000)

  it('allows at most one target activity per schedule type', async () => {
    await as.asSuperuser()
    await expect(
      db.exec(`insert into activity_catalog (schedule_type, code, name, phase, sequence, default_days, is_target)
               values ('test', 'T2', 'Second target', 'P2', 4, 0, true)`),
    ).rejects.toThrow(/duplicate key|unique/i)
  })

  it('rejects duplicate codes in a type, non-positive actual durations and duplicate project activities', async () => {
    await as.asSuperuser()
    await expect(
      db.exec(`insert into activity_catalog (schedule_type, code, name, phase, sequence, default_days) values ('test', 'A', 'Again', 'P1', 9, 1)`),
    ).rejects.toThrow(/duplicate key|unique/i)
    const p = '00000000-0000-4000-8000-000000000003'
    await expect(
      db.query(`insert into history_activities (project_id, schedule_type, code, actual_days) values ($1, 'test', 'B', 0)`, [p]),
    ).rejects.toThrow(/check constraint/i)
    await expect(
      db.query(`insert into history_activities (project_id, schedule_type, code, actual_days) values ($1, 'test', 'A', 5)`, [p]),
    ).rejects.toThrow(/duplicate key|unique/i)
  })

  it("rejects a history activity whose code is not in its project's catalog", async () => {
    await as.asSuperuser()
    const p = '00000000-0000-4000-8000-000000000003'
    await expect(
      db.query(`insert into history_activities (project_id, schedule_type, code, actual_days) values ($1, 'test', 'ZZ', 5)`, [p]),
    ).rejects.toThrow(/foreign key/i)
    // ...or claims another schedule type than its project's.
    await expect(
      db.query(`insert into history_activities (project_id, schedule_type, code, actual_days) values ($1, $2, 'SPEC', 5)`, [p, LLE]),
    ).rejects.toThrow(/foreign key/i)
  })

  it('rejects default_links that are not a JSON array', async () => {
    await as.asSuperuser()
    await expect(
      db.exec(`insert into activity_catalog (schedule_type, code, name, phase, sequence, default_links, default_days)
               values ('test', 'C', 'C', 'P1', 5, '{"from":"A"}', 1)`),
    ).rejects.toThrow(/check constraint/i)
  })

  it('deleting a project removes its activities', async () => {
    await as.asSuperuser()
    await db.exec(`delete from history_projects where id = '00000000-0000-4000-8000-000000000001'`)
    expect(await count('history_activities', `schedule_type = 'test'`)).toBe(5)
  })
})

describe('access (a read-only shared library)', () => {
  beforeEach(() => seedTestType(), 30_000)

  it('gives anon nothing: every read, write and the summary function are refused', async () => {
    await as.asAnon()
    for (const t of [...TABLES, 'planner_equipment_types']) {
      await expect(db.query(`select count(*) from ${t}`)).rejects.toThrow(/permission denied/i)
    }
    await expect(db.query(`select planner_history_summary('test')`)).rejects.toThrow(/permission denied/i)
    await expect(db.exec(`insert into schedule_types (id, name) values ('x', 'x')`)).rejects.toThrow(/permission denied/i)
  })

  it('lets any signed-in user read every table, the equipment view and the summary', async () => {
    await as.asUser(USER)
    expect(await count('schedule_types', `id = 'test'`)).toBe(1)
    expect(await count('activity_catalog', `schedule_type = 'test'`)).toBe(3)
    expect(await count('history_projects', `schedule_type = 'test'`)).toBe(5)
    expect(await count('history_activities', `schedule_type = 'test'`)).toBe(7)
    const eq = await db.query<{ equipment_type: string }>(
      `select equipment_type from planner_equipment_types where schedule_type = 'test' order by 1`,
    )
    expect(eq.rows.map((r) => r.equipment_type)).toEqual(['Pump', 'Valve'])
    expect((await summary('test')).projectCount).toBe(5)
  })

  it('refuses inserts, updates and deletes from signed-in users on every table', async () => {
    await as.asUser(USER)
    await expect(db.exec(`insert into schedule_types (id, name) values ('x', 'x')`)).rejects.toThrow(/permission denied/i)
    await expect(
      db.exec(`insert into history_projects (schedule_type, equipment_type, equipment_name) values ('test', 'Pump', 'x')`),
    ).rejects.toThrow(/permission denied/i)
    for (const t of TABLES) {
      await expect(db.exec(`update ${t} set ${t === 'history_activities' ? 'actual_days = 1' : t === 'history_projects' ? "notes = 'x'" : "name = 'x'"}`)).rejects.toThrow(
        /permission denied/i,
      )
      await expect(db.exec(`delete from ${t}`)).rejects.toThrow(/permission denied/i)
    }
    await as.asSuperuser()
    expect(await count('history_activities', `schedule_type = 'test'`)).toBe(7)
  })

  it('enables row-level security on every table, with a single select policy for authenticated', async () => {
    await as.asSuperuser()
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname = any($1) order by relname`,
      [[...TABLES]],
    )
    expect(rls.rows.every((r) => r.relrowsecurity)).toBe(true)
    expect(rls.rows).toHaveLength(4)
    const pol = await db.query<{ tablename: string; cmd: string; roles: string[] }>(
      `select tablename, cmd, roles::text[] as roles from pg_policies where tablename = any($1) order by tablename`,
      [[...TABLES]],
    )
    expect(pol.rows).toHaveLength(4)
    for (const p of pol.rows) {
      expect(p.cmd).toBe('SELECT')
      expect(p.roles).toEqual(['authenticated'])
    }
  })

  it('runs the summary as SECURITY INVOKER with a fixed search_path', async () => {
    await as.asSuperuser()
    const f = await db.query<{ prosecdef: boolean; proconfig: string[] }>(
      `select prosecdef, proconfig from pg_proc where proname = 'planner_history_summary'`,
    )
    expect(f.rows).toEqual([{ prosecdef: false, proconfig: ['search_path=public'] }])
  })
})
