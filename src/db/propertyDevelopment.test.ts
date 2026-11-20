// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PROPERTY_DEVELOPMENT_ACTIVITIES as A, PROPERTY_DEVELOPMENT_TYPE as T } from '../planner/catalogs/propertyDevelopment'
import { createSupabaseLikeDb, roles } from './supabaseTestDb'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// 0018_property_development.sql against the module it comes from (verified against PGlite).
let db: PGlite

beforeAll(async () => {
  db = await createSupabaseLikeDb()
}, 60_000)
afterAll(async () => {
  await db.close()
}, 60_000)

describe('0018 property development schedule type', () => {
  it('offers the type under Properties, first, with the wizard wording', async () => {
    const t = (await db.query<{ id: string; name: string; position: number; project_types: string[]; item_labels: Record<string, string> }>(
      `select id, name, position, project_types, item_labels from schedule_types where id = $1`,
      [T.id],
    )).rows[0]
    expect(t).toMatchObject({ name: T.name, position: 0, project_types: ['properties'] })
    expect(t.item_labels).toEqual(T.itemLabels)
    const first = (await db.query<{ id: string }>(`select id from schedule_types where 'properties' = any(project_types) order by position, name limit 1`)).rows[0]
    expect(first.id).toBe(T.id)
  })

  it('seeds exactly the module: codes, names, stages, links, defaults, target and reference details', async () => {
    const rows = (await db.query<{
      code: string
      name: string
      phase: string
      sequence: number
      default_links: unknown
      default_days: number
      is_target: boolean
      activity_id: string
      responsibility: string
      criteria: string
    }>(`select code, name, phase, sequence, default_links, default_days, is_target, activity_id, responsibility, criteria from activity_catalog where schedule_type = $1 order by sequence`, [T.id])).rows
    expect(rows).toEqual(
      A.map((a, i) => ({
        code: a.id,
        name: a.name,
        phase: a.stage,
        sequence: i + 1,
        default_links: a.links,
        default_days: a.defaultDays,
        is_target: a.id === T.targetId,
        activity_id: a.id,
        responsibility: a.responsibility,
        criteria: a.criteria,
      })),
    )
  })

  it('is readable by a signed-in user and not by anon (the shared reference library)', async () => {
    const as = roles(db)
    await as.asUser('11111111-1111-1111-1111-111111111111')
    expect((await db.query(`select code from activity_catalog where schedule_type = $1`, [T.id])).rows).toHaveLength(44)
    await as.asAnon()
    await expect(db.query(`select code from activity_catalog`)).rejects.toThrow()
    await as.asSuperuser()
  })
})
