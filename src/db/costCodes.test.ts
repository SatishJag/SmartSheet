// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSupabaseLikeDb, roles } from './supabaseTestDb'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// Verified against PGlite (Postgres in WASM), not a live Supabase project (see supabaseTestDb.ts).

const USER = '11111111-1111-1111-1111-111111111111'

let db: PGlite
let as: ReturnType<typeof roles>

beforeAll(async () => {
  db = await createSupabaseLikeDb()
  as = roles(db)
}, 60_000)
afterAll(async () => {
  await db.close()
}, 60_000)

describe('0019_cost_codes', () => {
  it('seeds the 15 Procore cost codes exactly', async () => {
    await as.asUser(USER)
    const r = await db.query<{ code: string; description: string }>(`select code, description from cost_codes order by code`)
    expect(r.rows).toEqual([
      { code: 'ADV', description: 'Advance Payment' },
      { code: 'ADV-REC', description: 'Advance Payment Recovery' },
      { code: 'AUH', description: 'Authority' },
      { code: 'CHL', description: 'Chiller' },
      { code: 'CLT', description: 'Colling Tower' },
      { code: 'CONS', description: 'Consultancy Fees' },
      { code: 'CRAC', description: 'CRAC/CRAH/FWU' },
      { code: 'CSA', description: 'Civil & Structural' },
      { code: 'DU', description: 'Coolant & Distribution Unit' },
      { code: 'ELE', description: 'Elevator' },
      { code: 'GEN', description: 'Generator' },
      { code: 'HVS', description: 'HV SiwtchGear' },
      { code: 'POW', description: 'Power Skid' },
      { code: 'TRF', description: 'Transformer' },
      { code: 'UPS', description: 'UPS & Battery System' },
    ])
  })

  it('offers exactly the five MVP codes to the planner, each mapped to an equipment type', async () => {
    await as.asUser(USER)
    const r = await db.query(`select code, equipment_type from cost_codes where in_planner order by code`)
    expect(r.rows).toEqual([
      { code: 'CHL', equipment_type: 'Chiller' },
      { code: 'ELE', equipment_type: 'Elevator' },
      { code: 'GEN', equipment_type: 'Diesel generator' },
      { code: 'HVS', equipment_type: 'HV switchgear' },
      { code: 'TRF', equipment_type: 'Power transformer' },
    ])
  })

  it('maps only to equipment types the planner has history for', async () => {
    await as.asUser(USER)
    const r = await db.query(
      `select equipment_type from cost_codes where equipment_type is not null
       except select equipment_type from planner_equipment_types`,
    )
    expect(r.rows).toEqual([])
  })

  it('rejects a description with a comma (dropdown options cannot hold one)', async () => {
    await as.asSuperuser()
    await expect(db.query(`insert into cost_codes (code, description) values ('X', 'A, B')`)).rejects.toThrow()
  })

  it('is read-only for users and closed to anon', async () => {
    await as.asUser(USER)
    await expect(db.query(`insert into cost_codes (code, description) values ('X', 'X')`)).rejects.toThrow()
    await expect(db.query(`update cost_codes set in_planner = true where code = 'UPS'`)).rejects.toThrow()
    await as.asAnon()
    await expect(db.query(`select * from cost_codes`)).rejects.toThrow()
  })
})
