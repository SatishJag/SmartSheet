// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSupabaseLikeDb, roles } from './supabaseTestDb'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// Verified against PGlite (Postgres in WASM), not a live Supabase project (see supabaseTestDb.ts).
// 0012 adds the parallel work to LLE procurement; 0013 adds the other schedule types and says which
// project types offer them.

const USER = '11111111-1111-1111-1111-111111111111'
let db: PGlite

beforeAll(async () => {
  db = await createSupabaseLikeDb()
  await roles(db).asUser(USER)
}, 60_000)
afterAll(async () => {
  await db.close()
}, 60_000)

type Link = { from: string; type: string; lagDays: number }
type Row = { code: string; sequence: number; default_links: Link[]; default_days: number; is_target: boolean }

async function catalog(type: string): Promise<Row[]> {
  const r = await db.query<Row>(
    `select code, sequence, default_links, default_days, is_target from activity_catalog where schedule_type = $1 order by sequence`,
    [type],
  )
  return r.rows
}

/** Schedule type ids offered under a project type, in the order the wizard lists them. */
async function offered(projectType: string): Promise<string[]> {
  const r = await db.query<{ id: string }>(
    `select id from schedule_types where cardinality(project_types) = 0 or $1 = any(project_types) order by position, name`,
    [projectType],
  )
  return r.rows.map((x) => x.id)
}

describe('0013_more_schedule_types', () => {
  it('offers different schedule types under Data centre and Properties, each opening on its main one', async () => {
    expect(await offered('data-centre')).toEqual(['lle-procurement', 'other-equipment-procurement', 'subcontract-procurement', 'consultant-appointment'])
    expect(await offered('properties')).toEqual(['materials-procurement', 'lle-procurement', 'subcontract-procurement', 'consultant-appointment'])
  })

  it('lists only project types that exist, and every type says that its durations are placeholders', async () => {
    const unknown = await db.query(`select s.id, p from schedule_types s, unnest(s.project_types) p where p not in (select id from project_types)`)
    expect(unknown.rows).toEqual([])
    const r = await db.query<{ id: string; description: string }>(`select id, description from schedule_types where id <> 'lle-procurement' order by id`)
    expect(r.rows).toHaveLength(4)
    for (const t of r.rows) expect(t.description, t.id).toMatch(/placeholders/)
  })

  it('gives every schedule type a coherent catalog: sequence 1..n, one target last, links to real codes, no loops', async () => {
    const types = (await db.query<{ id: string }>(`select id from schedule_types order by id`)).rows.map((x) => x.id)
    expect(types).toHaveLength(5)
    for (const type of types) {
      const rows = await catalog(type)
      expect(rows.length, type).toBeGreaterThanOrEqual(7)
      expect(rows.map((r) => r.sequence), type).toEqual(rows.map((_, i) => i + 1))
      expect(rows.filter((r) => r.is_target), type).toHaveLength(1)
      expect(rows[rows.length - 1].is_target, `${type}: the target is last`).toBe(true)
      const codes = new Set(rows.map((r) => r.code))
      for (const r of rows) {
        for (const l of r.default_links) {
          expect(codes.has(l.from), `${type}: ${r.code} <- ${l.from}`).toBe(true)
          expect(l.from).not.toBe(r.code)
          expect(['FS', 'SS', 'FF', 'SF']).toContain(l.type)
        }
        if (!r.is_target || r.default_days > 0) expect(r.default_days, `${type}: ${r.code}`).toBeGreaterThan(0)
      }
      // Kahn's algorithm: every activity is reachable in topological order.
      const done = new Set<string>()
      for (let progress = true; progress; ) {
        progress = false
        for (const r of rows) {
          if (!done.has(r.code) && r.default_links.every((l) => done.has(l.from))) {
            done.add(r.code)
            progress = true
          }
        }
      }
      expect(done.size, `${type} has a loop`).toBe(rows.length)
    }
  })

  it('keeps the Procurement app’s stage lists and logic', async () => {
    const sizes = Object.fromEntries(
      await Promise.all(
        ['materials-procurement', 'other-equipment-procurement', 'subcontract-procurement', 'consultant-appointment'].map(
          async (t) => [t, (await catalog(t)).length] as const,
        ),
      ),
    )
    expect(sizes).toEqual({ 'materials-procurement': 7, 'other-equipment-procurement': 11, 'subcontract-procurement': 9, 'consultant-appointment': 7 })
    const oeq = await catalog('other-equipment-procurement')
    expect(oeq.find((r) => r.code === 'MANUFACTURE')!.default_links).toEqual([{ from: 'RELEASE', type: 'FS', lagDays: 0 }])
    expect(oeq[oeq.length - 1].code).toBe('RECEIVE_ACCEPT')
  })
})

describe('0012_lle_parallel_work', () => {
  it('adds work that runs alongside manufacturing, and makes FAT and release wait for it', async () => {
    const rows = await catalog('lle-procurement')
    expect(rows).toHaveLength(17)
    const by = new Map(rows.map((r) => [r.code, r]))
    expect(by.get('FATPREP')!.default_links).toEqual([{ from: 'DWGAPP', type: 'FS', lagDays: 0 }])
    expect(by.get('FRTFWD')!.default_links).toEqual([{ from: 'AWARD', type: 'FS', lagDays: 0 }])
    expect(by.get('SHIPDOC')!.default_links).toEqual([{ from: 'FRTFWD', type: 'FS', lagDays: 0 }])
    expect(by.get('FAT')!.default_links.map((l) => l.from).sort()).toEqual(['FATPREP', 'MFG'])
    expect(by.get('RELEASE')!.default_links.map((l) => l.from).sort()).toEqual(['FAT', 'SHIPDOC'])
    expect(rows[rows.length - 1].code).toBe('ONSITE')
  })

  it('leaves the sample history usable: the new activities simply have none', async () => {
    const r = await db.query<{ s: { projectCount: number; stats: { code: string; n: number }[] } }>(
      `select planner_history_summary('lle-procurement', 'Chiller') as s`,
    )
    expect(r.rows[0].s.projectCount).toBeGreaterThan(0)
    const withHistory = r.rows[0].s.stats.map((x) => x.code)
    expect(withHistory).toContain('MFG')
    for (const code of ['FATPREP', 'FRTFWD', 'SHIPDOC']) expect(withHistory).not.toContain(code)
  })
})
