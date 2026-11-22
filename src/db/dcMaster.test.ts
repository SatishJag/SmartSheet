// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DC_MASTER_TYPE as T } from '../planner/catalogs/dcMaster'
import { dcMasterCatalog } from '../planner/catalogs/dcMasterCatalog'
import { createSupabaseLikeDb } from './supabaseTestDb'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// 0023_dc_master.sql against the module it is generated from (verified against PGlite).
let db: PGlite

beforeAll(async () => {
  db = await createSupabaseLikeDb()
}, 60_000)
afterAll(async () => {
  await db.close()
}, 60_000)

describe('0023 Data centre master schedule type', () => {
  it('offers the type under Data centre, first, with the wizard wording', async () => {
    const t = (await db.query<{ name: string; position: number; project_types: string[]; item_labels: Record<string, string> }>(
      `select name, position, project_types, item_labels from schedule_types where id = $1`,
      [T.id],
    )).rows[0]
    expect(t).toMatchObject({ name: T.name, position: 0, project_types: ['data-centre'] })
    expect(t.item_labels).toEqual(T.itemLabels)
    const first = (await db.query<{ id: string }>(`select id from schedule_types where 'data-centre' = any(project_types) order by position, name limit 1`)).rows[0]
    expect(first.id).toBe(T.id)
  })

  it('seeds exactly the module', async () => {
    const rows = (await db.query<Record<string, unknown>>(
      `select code, name, phase, sequence, default_links, default_days, is_target, activity_id, responsibility, criteria from activity_catalog where schedule_type = $1 order by sequence`,
      [T.id],
    )).rows
    expect(rows).toEqual(
      dcMasterCatalog().map((c) => ({
        code: c.code,
        name: c.name,
        phase: c.phase,
        sequence: c.sequence,
        default_links: c.defaultLinks,
        default_days: c.defaultDays,
        is_target: c.isTarget,
        activity_id: c.activityId,
        responsibility: c.responsibility,
        criteria: c.criteria,
      })),
    )
  })
})
