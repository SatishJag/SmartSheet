// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseLikeDb, roles } from './supabaseTestDb'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// Verified against PGlite (Postgres in WASM), not a live Supabase project (see supabaseTestDb.ts).

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const SHEET = 'aaaaaaaa-0000-0000-0000-0000000000a1'
const R1 = 'aaaaaaaa-0000-0000-0000-0000000000b1'
const R2 = 'aaaaaaaa-0000-0000-0000-0000000000b2'

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
  await db.exec('delete from sheets') // cascades to rows, baselines, baseline_rows
  await as.asUser(A)
  await db.query(`insert into sheets (id, name) values ($1, 'Plan A')`, [SHEET])
  await db.query(`insert into rows (id, sheet_id, position) values ($1, $3, 'a0'), ($2, $3, 'a1')`, [R1, R2, SHEET])
})

const rows = (...items: [string, string, string, number][]) =>
  JSON.stringify(items.map(([rowId, start, end, durationDays]) => ({ rowId, start, end, durationDays })))

async function save(slot: number, name: string, payload: string): Promise<string> {
  const r = await db.query<{ id: string }>(`select save_baseline($1, $2, $3, $4::jsonb) as id`, [SHEET, slot, name, payload])
  return r.rows[0].id
}
const count = async (table: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n

describe('save_baseline', () => {
  it('stores the snapshot: one baseline row plus a row per scheduled row, owned by the caller', async () => {
    const id = await save(1, 'Contract', rows([R1, '2026-11-09', '2026-11-11', 3], [R2, '2026-11-12', '2026-11-13', 2]))
    const b = await db.query<{ slot: number; name: string; owner_id: string }>(`select slot, name, owner_id from baselines where id = $1`, [id])
    expect(b.rows[0]).toEqual({ slot: 1, name: 'Contract', owner_id: A })
    const r = await db.query<{ row_id: string; start_date: string; end_date: string; duration_days: number }>(
      `select row_id, start_date::text, end_date::text, duration_days from baseline_rows where baseline_id = $1 order by start_date`,
      [id],
    )
    expect(r.rows).toEqual([
      { row_id: R1, start_date: '2026-11-09', end_date: '2026-11-11', duration_days: 3 },
      { row_id: R2, start_date: '2026-11-12', end_date: '2026-11-13', duration_days: 2 },
    ])
  })

  it('saving into a used slot replaces that baseline atomically; other slots are untouched', async () => {
    const first = await save(1, 'Old', rows([R1, '2026-11-09', '2026-11-11', 3]))
    await save(2, 'Other', rows([R1, '2026-11-10', '2026-11-12', 3]))
    const second = await save(1, 'New', rows([R2, '2026-11-12', '2026-11-13', 2]))
    expect(second).not.toBe(first)
    expect(await count('baselines')).toBe(2)
    expect((await db.query<{ n: number }>(`select count(*)::int n from baseline_rows where baseline_id = $1`, [first])).rows[0].n).toBe(0)
    expect((await db.query<{ name: string }>(`select name from baselines where slot = 1`)).rows[0].name).toBe('New')
    expect(await count('baseline_rows')).toBe(2) // slot 1: one row; slot 2: one row
  })

  it('allows slots 1 to 5 only, and a non-empty name of at most 100 characters', async () => {
    const one = rows([R1, '2026-11-09', '2026-11-11', 3])
    for (const slot of [0, 6]) await expect(save(slot, 'x', one)).rejects.toThrow()
    await expect(save(1, '   ', one)).rejects.toThrow()
    await expect(save(1, 'x'.repeat(101), one)).rejects.toThrow()
    for (const slot of [1, 2, 3, 4, 5]) await save(slot, `Baseline ${slot}`, one)
    expect(await count('baselines')).toBe(5)
  })

  it('rejects an end before its start and a negative duration, leaving nothing half-saved', async () => {
    await save(1, 'Good', rows([R1, '2026-11-09', '2026-11-11', 3]))
    await expect(save(1, 'Bad', rows([R1, '2026-11-12', '2026-11-11', 3]))).rejects.toThrow()
    await expect(save(1, 'Bad', rows([R1, '2026-11-09', '2026-11-11', -1]))).rejects.toThrow()
    // The failed save ran in one statement: the good baseline is still there.
    expect((await db.query<{ name: string }>(`select name from baselines where slot = 1`)).rows[0].name).toBe('Good')
  })

  it('survives deleting a row: the baseline keeps what the plan said then', async () => {
    const id = await save(1, 'Contract', rows([R1, '2026-11-09', '2026-11-11', 3], [R2, '2026-11-12', '2026-11-13', 2]))
    await db.query(`delete from rows where id = $1`, [R2])
    expect((await db.query<{ n: number }>(`select count(*)::int n from baseline_rows where baseline_id = $1`, [id])).rows[0].n).toBe(2)
  })

  it('is deleted with its sheet', async () => {
    await save(1, 'Contract', rows([R1, '2026-11-09', '2026-11-11', 3]))
    await db.query(`delete from sheets where id = $1`, [SHEET])
    expect(await count('baselines')).toBe(0)
    expect(await count('baseline_rows')).toBe(0)
  })
})

describe('access', () => {
  it("another user can neither read nor write a user's baselines, nor save one onto their sheet", async () => {
    await save(1, 'Contract', rows([R1, '2026-11-09', '2026-11-11', 3]))
    await as.asUser(B)
    expect(await count('baselines')).toBe(0)
    expect(await count('baseline_rows')).toBe(0)
    await expect(save(2, 'Intruder', rows([R1, '2026-11-09', '2026-11-11', 3]))).rejects.toThrow()
    await expect(save(1, 'Overwrite', rows([R1, '2026-11-09', '2026-11-11', 3]))).rejects.toThrow()
    await as.asUser(A)
    expect((await db.query<{ name: string }>(`select name from baselines where slot = 1`)).rows[0].name).toBe('Contract')
  })

  it('anon has no access to the tables or the function', async () => {
    await as.asAnon()
    await expect(db.query(`select * from baselines`)).rejects.toThrow(/permission denied/)
    await expect(db.query(`select * from baseline_rows`)).rejects.toThrow(/permission denied/)
    await expect(save(1, 'x', rows([R1, '2026-11-09', '2026-11-11', 3]))).rejects.toThrow(/permission denied/)
  })

  it('a signed-in user cannot attach baseline rows to a baseline of another sheet', async () => {
    const id = await save(1, 'Contract', rows([R1, '2026-11-09', '2026-11-11', 3]))
    await db.query(`insert into sheets (id, name) values ('aaaaaaaa-0000-0000-0000-0000000000a2', 'Other')`)
    await expect(
      db.query(
        `insert into baseline_rows (baseline_id, sheet_id, row_id, start_date, end_date, duration_days)
         values ($1, 'aaaaaaaa-0000-0000-0000-0000000000a2', $2, '2026-11-09', '2026-11-09', 1)`,
        [id, R2],
      ),
    ).rejects.toThrow()
  })

  it('the function is SECURITY INVOKER with a pinned search_path', async () => {
    await as.asSuperuser()
    const r = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
      `select prosecdef, proconfig from pg_proc where proname = 'save_baseline'`,
    )
    expect(r.rows[0].prosecdef).toBe(false)
    expect(r.rows[0].proconfig).toContain('search_path=public')
  })
})
