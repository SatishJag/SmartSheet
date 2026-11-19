// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { anchorOf } from '../procurement/backSchedule'
import { procurementType } from '../procurement/catalog'
import { catalogRows, GENERATED_SCHEDULE_TYPES, migration0013Sql } from '../procurement/dbCatalog'
import { EQUIPMENT_TYPES } from '../procurement/equipment'
import type { ProcurementType } from '../procurement/types'
import { createSupabaseLikeDb, MIGRATIONS_DIR, roles } from './supabaseTestDb'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// The database is the master of the schedule types; the procurement module (src/procurement) is the
// source of the schedules it was generated from. These tests stop the two drifting apart.

const USER = '11111111-1111-1111-1111-111111111111'
let db: PGlite

beforeAll(async () => {
  db = await createSupabaseLikeDb()
  await roles(db).asUser(USER)
}, 60_000)
afterAll(async () => {
  await db.close()
}, 60_000)

describe('migration 0013 and the procurement module', () => {
  it('is exactly what `npm run gen:schedule-types` writes', () => {
    const committed = readFileSync(resolve(MIGRATIONS_DIR, '0013_more_schedule_types.sql'), 'utf8')
    expect(committed, 'run `npm run gen:schedule-types` and commit the result (or, if 0013 is already deployed, add a new migration)').toBe(migration0013Sql())
  })

  it.each(GENERATED_SCHEDULE_TYPES.map((s) => [s.id, s] as const))('%s: the catalog in the database is the module’s activities and logic', async (_id, spec) => {
    const r = await db.query<{ code: string; name: string; phase: string; sequence: number; default_links: unknown; default_days: number; is_target: boolean }>(
      `select code, name, phase, sequence, default_links, default_days, is_target from activity_catalog where schedule_type = $1 order by sequence`,
      [spec.id],
    )
    const actual = r.rows.map((x) => ({
      scheduleType: spec.id,
      code: x.code,
      name: x.name,
      phase: x.phase,
      sequence: x.sequence,
      defaultLinks: x.default_links,
      defaultDays: x.default_days,
      isTarget: x.is_target,
    }))
    expect(actual).toEqual(catalogRows(spec))
  })

  it('offers the types under the project types the spec lists, in its position', async () => {
    for (const spec of GENERATED_SCHEDULE_TYPES) {
      const r = await db.query<{ project_types: string[]; position: number }>(`select project_types, position from schedule_types where id = $1`, [spec.id])
      expect(r.rows[0], spec.id).toEqual({ project_types: spec.projectTypes, position: spec.position })
    }
  })

  it('says in the wizard’s words what each type plans, as the spec does (0014); other types plan equipment', async () => {
    for (const spec of GENERATED_SCHEDULE_TYPES) {
      const r = await db.query<{ item_labels: unknown }>(`select item_labels from schedule_types where id = $1`, [spec.id])
      expect(r.rows[0].item_labels, spec.id).toEqual(spec.itemLabels)
    }
    const lle = await db.query<{ item_labels: { noun: string } }>(`select item_labels from schedule_types where id = 'lle-procurement'`)
    expect(lle.rows[0].item_labels.noun).toBe('equipment')
    await expect(db.query(`update schedule_types set item_labels = '{"noun":""}' where id = 'lle-procurement'`)).rejects.toThrow()
  })

  it('has a spec for every general procurement type, and nothing else', () => {
    const general = ['MAT', 'OEQ', 'SUB', 'CON']
    expect(GENERATED_SCHEDULE_TYPES.map((s) => s.moduleCode)).toEqual(general)
    for (const code of general) expect(procurementType(code)!.kind).toBe('general')
  })
})

describe('long-lead equipment: the database catalog (0005, 0012) agrees with the module’s equipment chains', () => {
  // Each database activity that has a counterpart in the module's post-award chain, by the stage the
  // module gives it. The database catalog also covers the pre-award steps and raw material, which the
  // module's chains do not; those are left out here. ONSITE is the activity that brings the goods to site.
  const STAGE: Record<string, string> = {
    DWGSUB: 'Submittals',
    DWGAPP: 'Approval',
    MFG: 'Manufacturing',
    FATPREP: 'FAT preparation',
    FAT: 'FAT',
    FRTFWD: 'Freight planning',
    SHIPDOC: 'Shipping documents',
    RELEASE: 'Dispatch',
    SHIP: 'Transit',
    CUSTOMS: 'Customs',
    DELIVER: 'Local handling',
  }

  const reaches = (type: ProcurementType, from: string, to: string): boolean => {
    const by = new Map(type.activities.map((a) => [a.code, a]))
    const seen = new Set<string>()
    const stack = [to]
    while (stack.length > 0) {
      const c = stack.pop()!
      for (const p of by.get(c)?.predecessors ?? []) {
        if (p === from) return true
        if (!seen.has(p)) {
          seen.add(p)
          stack.push(p)
        }
      }
    }
    return false
  }

  it.each(EQUIPMENT_TYPES.map((t) => [t.code, t] as const))('%s: every database link between counterparts is in the module’s logic', async (_c, type) => {
    const r = await db.query<{ code: string; default_links: { from: string; type: string }[] }>(
      `select code, default_links from activity_catalog where schedule_type = 'lle-procurement'`,
    )
    const node = (dbc: string): string | undefined =>
      dbc === 'ONSITE' ? anchorOf(type) : type.activities.find((a) => a.stage === STAGE[dbc])?.code
    let checked = 0
    for (const row of r.rows) {
      for (const link of row.default_links) {
        if (link.type !== 'FS') continue
        const a = node(link.from)
        const b = node(row.code)
        if (!a || !b || a === b) continue
        expect(reaches(type, a, b), `${type.code}: ${link.from} -> ${row.code} (${a} -> ${b})`).toBe(true)
        checked++
      }
    }
    // The non-critical streams of 0012 are among them
    expect(checked).toBeGreaterThanOrEqual(8)
  })

  it('the parallel work of 0012 is parallel in the module too: neither feeds manufacturing', () => {
    const chl = procurementType('CHL')!
    for (const stage of ['FAT preparation', 'Freight planning', 'Shipping documents']) {
      const a = chl.activities.find((x) => x.stage === stage)!
      const mfg = chl.activities.find((x) => x.stage === 'Manufacturing')!
      expect(reaches(chl, a.code, mfg.code), stage).toBe(false)
    }
  })
})
