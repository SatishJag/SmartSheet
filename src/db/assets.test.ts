// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseLikeDb, roles } from './supabaseTestDb'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// Verified against PGlite (Postgres in WASM), not a live Supabase project (see supabaseTestDb.ts).

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const SHEET_A = 'aaaaaaaa-0000-0000-0000-0000000000a1'
const SHEET_B = 'bbbbbbbb-0000-0000-0000-0000000000b1'
const uuid = (n: number) => `cccccccc-0000-0000-0000-${String(n).padStart(12, '0')}`

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
  await db.exec('delete from favorites; delete from workspace_items; delete from folders; delete from workspaces')
  await db.exec('delete from reports; delete from dashboards; delete from sheets')
  await as.asUser(A)
  await db.query(`insert into sheets (id, name) values ($1, 'Sheet A')`, [SHEET_A])
  await as.asUser(B)
  await db.query(`insert into sheets (id, name) values ($1, 'Sheet B')`, [SHEET_B])
  await as.asUser(A)
})

const count = async (table: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n
const newSpace = async (name = 'Site 1') =>
  (await db.query<{ id: string }>(`insert into workspaces (name) values ($1) returning id`, [name])).rows[0].id
const newFolder = async (space: string, parent: string | null, name = 'F') =>
  (await db.query<{ id: string }>(`insert into folders (space_id, parent_id, name) values ($1, $2, $3) returning id`, [space, parent, name])).rows[0].id
const newReport = async (name = 'R') =>
  (await db.query<{ id: string }>(`insert into reports (name, definition) values ($1, '{"sources":[]}') returning id`, [name])).rows[0].id
const newDashboard = async (name = 'D') =>
  (await db.query<{ id: string }>(`insert into dashboards (name, layout) values ($1, '{"widgets":[]}') returning id`, [name])).rows[0].id

describe('workspaces and folders', () => {
  it('are owned by the caller, with the tenant column filled in', async () => {
    const space = await newSpace()
    const r = await db.query<{ owner_id: string; workspace_id: string }>(`select owner_id, workspace_id from workspaces where id = $1`, [space])
    expect(r.rows[0]).toEqual({ owner_id: A, workspace_id: A })
  })

  it('reject blank or over-long names', async () => {
    await expect(db.query(`insert into workspaces (name) values ('   ')`)).rejects.toThrow()
    await expect(db.query(`insert into workspaces (name) values ($1)`, ['x'.repeat(101)])).rejects.toThrow()
    const space = await newSpace()
    await expect(newFolder(space, null, '')).rejects.toThrow()
    await expect(db.query(`insert into reports (name) values ('')`)).rejects.toThrow()
    await expect(db.query(`insert into dashboards (name) values ($1)`, ['x'.repeat(101)])).rejects.toThrow()
  })

  it('nest up to 5 levels and refuse a 6th', async () => {
    const space = await newSpace()
    let parent: string | null = null
    for (let level = 1; level <= 5; level++) parent = await newFolder(space, parent, `L${level}`)
    await expect(newFolder(space, parent, 'L6')).rejects.toThrow(/at most 5 levels/)
    expect(await count('folders')).toBe(5)
  })

  it('refuse a parent from another workspace', async () => {
    const one = await newSpace('One')
    const two = await newSpace('Two')
    const inOne = await newFolder(one, null)
    await expect(newFolder(two, inOne)).rejects.toThrow()
  })

  it('can be moved within the workspace, but not into themselves, a descendant, or beyond the depth limit', async () => {
    const space = await newSpace()
    const a = await newFolder(space, null, 'a')
    const b = await newFolder(space, a, 'b')
    const c = await newFolder(space, b, 'c')
    await expect(db.query(`update folders set parent_id = $1 where id = $1`, [a])).rejects.toThrow()
    await expect(db.query(`update folders set parent_id = $2 where id = $1`, [a, c])).rejects.toThrow(/into itself or one of its subfolders/)
    // A branch a > b > c moved under a 3-deep chain would be 6 levels: refused; under a 2-deep chain it is 5: fine.
    const x = await newFolder(space, null, 'x')
    const y = await newFolder(space, x, 'y')
    const z = await newFolder(space, y, 'z')
    await expect(db.query(`update folders set parent_id = $2 where id = $1`, [a, z])).rejects.toThrow(/at most 5 levels/)
    await db.query(`update folders set parent_id = $2 where id = $1`, [a, y])
    const parent = (await db.query<{ parent_id: string }>(`select parent_id from folders where id = $1`, [a])).rows[0].parent_id
    expect(parent).toBe(y)
    // Back to the top level.
    await db.query(`update folders set parent_id = null where id = $1`, [a])
  })

  it('cannot change workspace', async () => {
    const one = await newSpace('One')
    const two = await newSpace('Two')
    const f = await newFolder(one, null)
    await expect(db.query(`update folders set space_id = $2 where id = $1`, [f, two])).rejects.toThrow()
  })

  it('deleting a workspace removes its folders and placements but keeps the assets', async () => {
    const space = await newSpace()
    const folder = await newFolder(space, null)
    const report = await newReport()
    await db.query(`insert into workspace_items (space_id, folder_id, report_id) values ($1, $2, $3)`, [space, folder, report])
    await db.query(`insert into workspace_items (space_id, sheet_id) values ($1, $2)`, [space, SHEET_A])
    await db.query(`delete from workspaces where id = $1`, [space])
    expect(await count('folders')).toBe(0)
    expect(await count('workspace_items')).toBe(0)
    expect(await count('reports')).toBe(1)
    expect(await count('sheets')).toBe(1)
  })

  it('deleting a folder cascades to subfolders and their placements', async () => {
    const space = await newSpace()
    const a = await newFolder(space, null)
    const b = await newFolder(space, a)
    const dash = await newDashboard()
    await db.query(`insert into workspace_items (space_id, folder_id, dashboard_id) values ($1, $2, $3)`, [space, b, dash])
    await db.query(`delete from folders where id = $1`, [a])
    expect(await count('folders')).toBe(0)
    expect(await count('workspace_items')).toBe(0)
    expect(await count('dashboards')).toBe(1)
  })
})

describe('placements', () => {
  it('derive the asset type and hold exactly one asset', async () => {
    const space = await newSpace()
    const report = await newReport()
    const dash = await newDashboard()
    await db.query(`insert into workspace_items (space_id, sheet_id) values ($1, $2)`, [space, SHEET_A])
    await db.query(`insert into workspace_items (space_id, report_id) values ($1, $2)`, [space, report])
    await db.query(`insert into workspace_items (space_id, dashboard_id) values ($1, $2)`, [space, dash])
    const types = await db.query<{ asset_type: string }>(`select asset_type from workspace_items order by asset_type`)
    expect(types.rows.map((r) => r.asset_type)).toEqual(['dashboard', 'report', 'sheet'])
    await expect(db.query(`insert into workspace_items (space_id) values ($1)`, [space])).rejects.toThrow()
    await expect(
      db.query(`insert into workspace_items (space_id, sheet_id, report_id) values ($1, $2, $3)`, [space, SHEET_A, report]),
    ).rejects.toThrow()
  })

  it('allow one placement per asset (a move is an update)', async () => {
    const one = await newSpace('One')
    const two = await newSpace('Two')
    await db.query(`insert into workspace_items (space_id, sheet_id) values ($1, $2)`, [one, SHEET_A])
    await expect(db.query(`insert into workspace_items (space_id, sheet_id) values ($1, $2)`, [two, SHEET_A])).rejects.toThrow()
    await db.query(`update workspace_items set space_id = $1 where sheet_id = $2`, [two, SHEET_A])
    expect((await db.query<{ space_id: string }>(`select space_id from workspace_items`)).rows[0].space_id).toBe(two)
  })

  it('require the folder to be in the same workspace', async () => {
    const one = await newSpace('One')
    const two = await newSpace('Two')
    const folder = await newFolder(one, null)
    await expect(db.query(`insert into workspace_items (space_id, folder_id, sheet_id) values ($1, $2, $3)`, [two, folder, SHEET_A])).rejects.toThrow()
  })

  it('go away with the asset', async () => {
    const space = await newSpace()
    const report = await newReport()
    await db.query(`insert into workspace_items (space_id, sheet_id) values ($1, $2)`, [space, SHEET_A])
    await db.query(`insert into workspace_items (space_id, report_id) values ($1, $2)`, [space, report])
    await db.query(`delete from sheets where id = $1`, [SHEET_A])
    await db.query(`delete from reports where id = $1`, [report])
    expect(await count('workspace_items')).toBe(0)
  })
})

describe('reports and dashboards', () => {
  it('keep any json object up to a sane size, and nothing else', async () => {
    await db.query(`insert into reports (name, definition) values ('ok', '{"sources":["a"]}')`)
    await expect(db.query(`insert into reports (name, definition) values ('bad', '[1,2]')`)).rejects.toThrow()
    await expect(db.query(`insert into dashboards (name, layout) values ('bad', '"text"')`)).rejects.toThrow()
    const big = JSON.stringify({ blob: 'x'.repeat(270_000) })
    await expect(db.query(`insert into reports (name, definition) values ('big', $1::jsonb)`, [big])).rejects.toThrow()
  })

  it('stamp updated_at on every update', async () => {
    const id = await newReport()
    const before = (await db.query<{ updated_at: string }>(`select updated_at::text from reports where id = $1`, [id])).rows[0].updated_at
    await new Promise((r) => setTimeout(r, 15))
    await db.query(`update reports set name = 'Renamed' where id = $1`, [id])
    const after = (await db.query<{ updated_at: string }>(`select updated_at::text from reports where id = $1`, [id])).rows[0].updated_at
    expect(after > before).toBe(true)
  })
})

describe('favorites', () => {
  it('star every kind of asset once, and reject a second star or an empty row', async () => {
    const space = await newSpace()
    const folder = await newFolder(space, null)
    const report = await newReport()
    const dash = await newDashboard()
    await db.query(`insert into favorites (sheet_id) values ($1)`, [SHEET_A])
    await db.query(`insert into favorites (report_id) values ($1)`, [report])
    await db.query(`insert into favorites (dashboard_id) values ($1)`, [dash])
    await db.query(`insert into favorites (space_id) values ($1)`, [space])
    await db.query(`insert into favorites (folder_id) values ($1)`, [folder])
    const kinds = await db.query<{ kind: string }>(`select kind from favorites order by kind`)
    expect(kinds.rows.map((r) => r.kind)).toEqual(['dashboard', 'folder', 'report', 'sheet', 'workspace'])
    await expect(db.query(`insert into favorites (sheet_id) values ($1)`, [SHEET_A])).rejects.toThrow()
    await expect(db.query(`insert into favorites (id) values ($1)`, [uuid(1)])).rejects.toThrow()
    await expect(db.query(`insert into favorites (sheet_id, report_id) values ($1, $2)`, [SHEET_A, report])).rejects.toThrow()
  })

  it('go away with what they point at', async () => {
    const report = await newReport()
    const space = await newSpace()
    await db.query(`insert into favorites (report_id) values ($1)`, [report])
    await db.query(`insert into favorites (space_id) values ($1)`, [space])
    await db.query(`delete from reports where id = $1`, [report])
    await db.query(`delete from workspaces where id = $1`, [space])
    expect(await count('favorites')).toBe(0)
  })
})

describe('access', () => {
  it("another user can neither see nor change a user's assets", async () => {
    const space = await newSpace()
    const report = await newReport()
    await db.query(`insert into workspace_items (space_id, report_id) values ($1, $2)`, [space, report])
    await db.query(`insert into favorites (report_id) values ($1)`, [report])
    await as.asUser(B)
    for (const t of ['workspaces', 'folders', 'reports', 'dashboards', 'workspace_items', 'favorites']) expect(await count(t)).toBe(0)
    await db.query(`update reports set name = 'Hijacked' where id = $1`, [report])
    await db.query(`delete from workspaces where id = $1`, [space])
    await as.asUser(A)
    expect((await db.query<{ name: string }>(`select name from reports where id = $1`, [report])).rows[0].name).toBe('R')
    expect(await count('workspaces')).toBe(1)
  })

  it("a user cannot place, star or nest another user's rows, nor write as someone else", async () => {
    const space = await newSpace()
    const report = await newReport()
    await as.asUser(B)
    const mine = await newSpace('Mine')
    // B's workspace, A's sheet and report.
    await expect(db.query(`insert into workspace_items (space_id, sheet_id) values ($1, $2)`, [mine, SHEET_A])).rejects.toThrow()
    await expect(db.query(`insert into workspace_items (space_id, report_id) values ($1, $2)`, [mine, report])).rejects.toThrow()
    // A's workspace, B's sheet.
    await expect(db.query(`insert into workspace_items (space_id, sheet_id) values ($1, $2)`, [space, SHEET_B])).rejects.toThrow()
    await expect(db.query(`insert into folders (space_id, name) values ($1, 'x')`, [space])).rejects.toThrow()
    await expect(db.query(`insert into favorites (sheet_id) values ($1)`, [SHEET_A])).rejects.toThrow()
    await expect(db.query(`insert into favorites (report_id) values ($1)`, [report])).rejects.toThrow()
    await expect(db.query(`insert into reports (owner_id, name) values ($1, 'x')`, [A])).rejects.toThrow()
    await expect(db.query(`insert into workspaces (workspace_id, name) values ($1, 'x')`, [A])).rejects.toThrow()
  })

  it('anon has no access to any of the tables', async () => {
    await as.asAnon()
    for (const t of ['workspaces', 'folders', 'reports', 'dashboards', 'workspace_items', 'favorites']) {
      await expect(db.query(`select * from ${t}`)).rejects.toThrow(/permission denied/)
    }
  })
})
