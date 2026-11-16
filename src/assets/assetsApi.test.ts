// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { supabaseAssetsPersistence } from './assetsApi'
import { emptyLayout, emptyReportDefinition, newWidget } from './definition'
import { testBackend } from './testBackend'

function setup(sheets = ['Plan A', 'Plan B']) {
  const b = testBackend(sheets)
  return { ...b, p: supabaseAssetsPersistence(b.client) }
}

describe('workspaces and folders', () => {
  it('creates, renames and loads them', async () => {
    const { p } = setup()
    const w = await p.createWorkspace('Tower A')
    await p.renameWorkspace(w.id, 'Tower B')
    const f = await p.createFolder(w.id, null, 'Civil')
    const sub = await p.createFolder(w.id, f.id, 'Level 1')
    await p.renameFolder(sub.id, 'Level 2')
    const snap = await p.loadAll()
    expect(snap.workspaces.map((x) => x.name)).toEqual(['Tower B'])
    expect(snap.folders.map((x) => [x.name, x.parentId]).sort()).toEqual([['Civil', null], ['Level 2', f.id]])
    expect(snap.sheets.map((s) => s.name)).toEqual(['Plan A', 'Plan B'])
  })

  it('refuses a 6th level and moves a folder only inside its workspace', async () => {
    const { p } = setup()
    const w = await p.createWorkspace('W')
    const other = await p.createWorkspace('Other')
    let parent: string | null = null
    const chain: string[] = []
    for (let i = 0; i < 5; i++) {
      const f = await p.createFolder(w.id, parent, `L${i + 1}`)
      chain.push(f.id)
      parent = f.id
    }
    await expect(p.createFolder(w.id, parent, 'too deep')).rejects.toThrow(/at most 5 levels/)
    await expect(p.moveFolder(chain[0], chain[2])).rejects.toThrow(/into itself/)
    const stray = await p.createFolder(other.id, null, 'Stray')
    await expect(p.moveFolder(stray.id, chain[0])).rejects.toThrow()
  })

  it('deleting a workspace removes its folders and placements but not the assets', async () => {
    const { p, sheetIds } = setup()
    const w = await p.createWorkspace('W')
    const f = await p.createFolder(w.id, null, 'F')
    await p.placeAsset('sheet', sheetIds[0], { spaceId: w.id, folderId: f.id })
    const r = await p.createReport('Report', emptyReportDefinition())
    await p.placeAsset('report', r.id, { spaceId: w.id, folderId: null })
    await p.deleteWorkspace(w.id)
    const snap = await p.loadAll()
    expect([snap.workspaces, snap.folders, snap.placements].map((x) => x.length)).toEqual([0, 0, 0])
    expect(snap.sheets).toHaveLength(2)
    expect(snap.reports).toHaveLength(1)
  })
})

describe('placing assets', () => {
  it('places, moves and removes an asset, one placement per asset', async () => {
    const { p, sheetIds } = setup()
    const a = await p.createWorkspace('A')
    const b = await p.createWorkspace('B')
    const folder = await p.createFolder(b.id, null, 'F')
    const first = await p.placeAsset('sheet', sheetIds[0], { spaceId: a.id, folderId: null })
    expect(first).toMatchObject({ assetType: 'sheet', assetId: sheetIds[0], spaceId: a.id, folderId: null })
    const moved = await p.placeAsset('sheet', sheetIds[0], { spaceId: b.id, folderId: folder.id })
    expect(moved).toMatchObject({ id: first!.id, spaceId: b.id, folderId: folder.id })
    expect((await p.loadAll()).placements).toHaveLength(1)
    expect(await p.placeAsset('sheet', sheetIds[0], null)).toBeNull()
    expect((await p.loadAll()).placements).toHaveLength(0)
  })

  it('placements follow their assets when deleted', async () => {
    const { p, client, sheetIds } = setup()
    const w = await p.createWorkspace('W')
    const d = await p.createDashboard('Dash', emptyLayout())
    await p.placeAsset('dashboard', d.id, { spaceId: w.id, folderId: null })
    await p.placeAsset('sheet', sheetIds[1], { spaceId: w.id, folderId: null })
    await p.addFavorite('dashboard', d.id)
    await p.deleteDashboard(d.id)
    await client.from('sheets').delete().eq('id', sheetIds[1])
    const snap = await p.loadAll()
    expect(snap.placements).toEqual([])
    expect(snap.favorites).toEqual([])
  })
})

describe('reports and dashboards', () => {
  it('stores and returns the definition, leniently parsed', async () => {
    const { p } = setup()
    const def = { ...emptyReportDefinition(), sources: ['s1'], columns: [{ key: 'c:task', title: 'Task' }] }
    const r = await p.createReport('Open tasks', def)
    expect(r.definition).toEqual(def)
    const saved = await p.saveReport(r.id, { name: 'Renamed', definition: { ...def, gantt: true } })
    expect(typeof saved.updatedAt).toBe('string')
    const loaded = (await p.loadAll()).reports[0]
    expect(loaded).toMatchObject({ name: 'Renamed', definition: { gantt: true } })
  })

  it('stores a dashboard layout and its name separately', async () => {
    const { p } = setup()
    const d = await p.createDashboard('Site board', emptyLayout())
    const layout = { widgets: [newWidget('metric', 'm1', 0, 0)] }
    await p.saveDashboard(d.id, { layout })
    await p.saveDashboard(d.id, { name: 'Site board 2' })
    const loaded = (await p.loadAll()).dashboards[0]
    expect(loaded.name).toBe('Site board 2')
    expect(loaded.layout.widgets.map((w) => w.id)).toEqual(['m1'])
  })

  it('rejects a blank name', async () => {
    const { p } = setup()
    await expect(p.createReport('  ', emptyReportDefinition())).rejects.toThrow(/name_check/)
    await expect(p.createDashboard('x'.repeat(101), emptyLayout())).rejects.toThrow(/name_check/)
  })
})

describe('favorites', () => {
  it('stars each kind once and unstars', async () => {
    const { p, sheetIds } = setup()
    const w = await p.createWorkspace('W')
    const f = await p.createFolder(w.id, null, 'F')
    const star = await p.addFavorite('sheet', sheetIds[0])
    await p.addFavorite('workspace', w.id)
    await p.addFavorite('folder', f.id)
    expect(star).toEqual({ id: expect.any(String), kind: 'sheet', targetId: sheetIds[0] })
    await expect(p.addFavorite('sheet', sheetIds[0])).rejects.toThrow(/duplicate/)
    await p.removeFavorite(star.id)
    expect((await p.loadAll()).favorites.map((x) => x.kind).sort()).toEqual(['folder', 'workspace'])
  })
})

describe('isolation', () => {
  it('another user sees none of it and cannot place a foreign sheet', async () => {
    const mine = setup()
    const w = await mine.p.createWorkspace('Mine')
    await mine.p.createReport('Secret', emptyReportDefinition())
    // The same database, a second signed-in user.
    const state = JSON.parse(mine.storage.map.get('fakeSupabase:v1')!)
    state.users.push({ id: 'u2', email: 'u2@example.com', password: 'pw-pw-pw', created_at: new Date().toISOString() })
    state.sessionUserId = 'u2'
    mine.storage.map.set('fakeSupabase:v1', JSON.stringify(state))
    const snap = await mine.p.loadAll()
    expect([snap.sheets, snap.workspaces, snap.reports].map((x) => x.length)).toEqual([0, 0, 0])
    const theirs = await mine.p.createWorkspace('Theirs')
    await expect(mine.p.placeAsset('sheet', mine.sheetIds[0], { spaceId: theirs.id, folderId: null })).rejects.toThrow()
    await expect(mine.p.placeAsset('sheet', mine.sheetIds[0], { spaceId: w.id, folderId: null })).rejects.toThrow()
  })
})
