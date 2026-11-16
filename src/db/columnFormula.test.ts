// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { allMigrations, createSupabaseLikeDb, MIGRATIONS_DIR, roles } from './supabaseTestDb'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// Verified against PGlite (Postgres in WASM), not a live Supabase project (see supabaseTestDb.ts).

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const SHEET = 'aaaaaaaa-0000-0000-0000-0000000000a1'
const COL = 'aaaaaaaa-0000-0000-0000-0000000000c1'

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
  await db.exec('delete from sheets')
  await as.asUser(A)
  await db.query(`insert into sheets (id, name) values ($1, 'Plan A')`, [SHEET])
  await db.query(`insert into columns (id, sheet_id, title, type, position) values ($1, $2, 'Total', 'TEXT_NUMBER', 0)`, [COL, SHEET])
})

const formulaOf = async () => (await db.query<{ formula: string | null }>(`select formula from columns where id = $1`, [COL])).rows[0].formula

describe('0007_column_formula', () => {
  it('is the last migration, and a new column has no formula', async () => {
    expect(allMigrations().at(-1)).toBe('0007_column_formula.sql')
    expect(await formulaOf()).toBeNull()
  })

  it('the owner can set, read and clear a column formula', async () => {
    await db.query(`update columns set formula = '=[Qty]*[Rate]' where id = $1`, [COL])
    expect(await formulaOf()).toBe('=[Qty]*[Rate]')
    await db.query(`update columns set formula = null where id = $1`, [COL])
    expect(await formulaOf()).toBeNull()
  })

  it('a column can be inserted with a formula', async () => {
    await db.query(`insert into columns (sheet_id, title, type, position, formula) values ($1, 'Calc', 'TEXT_NUMBER', 1, '=1+2')`, [SHEET])
    const r = await db.query<{ formula: string }>(`select formula from columns where title = 'Calc'`)
    expect(r.rows[0].formula).toBe('=1+2')
  })

  it('refuses text that is not a formula and formulas over 2,000 characters', async () => {
    await expect(db.query(`update columns set formula = '1+2' where id = $1`, [COL])).rejects.toThrow(/columns_formula_check/)
    await expect(db.query(`update columns set formula = $2 where id = $1`, [COL, '=' + '1'.repeat(2000)])).rejects.toThrow(/columns_formula_check/)
    await db.query(`update columns set formula = $2 where id = $1`, [COL, '=' + '1'.repeat(1999)]) // exactly 2,000 is fine
  })

  it('row-level security is unchanged: another user cannot see or change the formula', async () => {
    await db.query(`update columns set formula = '=1' where id = $1`, [COL])
    await as.asUser(B)
    expect((await db.query(`select formula from columns where id = $1`, [COL])).rows).toEqual([])
    await db.query(`update columns set formula = '=2' where id = $1`, [COL])
    await as.asSuperuser()
    expect(await formulaOf()).toBe('=1')
    await as.asAnon()
    await expect(db.query(`select formula from columns`)).rejects.toThrow()
  })

  it('applying it to a database that already has columns keeps them untouched', async () => {
    const before = allMigrations().filter((f) => f < '0007')
    const old = await createSupabaseLikeDb(before)
    try {
      await old.query(`insert into sheets (id, name, owner_id, workspace_id) values ($1, 'Old', $2, $2)`, [SHEET, A])
      await old.query(`insert into columns (id, sheet_id, owner_id, workspace_id, title, type, position, options) values ($1, $2, $3, $3, 'Status', 'PICKLIST', 0, '["a"]'::jsonb)`, [COL, SHEET, A])
      await old.exec(readFileSync(resolve(MIGRATIONS_DIR, '0007_column_formula.sql'), 'utf8'))
      const r = await old.query<{ title: string; options: unknown; formula: string | null }>(`select title, options, formula from columns`)
      expect(r.rows).toEqual([{ title: 'Status', options: ['a'], formula: null }])
    } finally {
      await old.close()
    }
  })
})
