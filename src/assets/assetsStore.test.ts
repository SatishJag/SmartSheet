// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { favoriteOf, searchAssets, unplacedAssets } from './assetModel'
import { supabaseAssetsPersistence, type AssetsPersistence } from './assetsApi'
import { createAssetsStore, validateAssetName } from './assetsStore'
import { emptyLayout, emptyReportDefinition, newWidget } from './definition'
import { testBackend } from './testBackend'

function setup(opts: { saveDelayMs?: number; wrap?: (p: AssetsPersistence) => AssetsPersistence } = {}) {
  const b = testBackend(['Plan A', 'Plan B'])
  const persistence = supabaseAssetsPersistence(b.client)
  const store = createAssetsStore(opts.wrap ? opts.wrap(persistence) : persistence, { saveDelayMs: opts.saveDelayMs ?? 5 })
  return { ...b, store, persistence }
}
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('validateAssetName', () => {
  it('trims and enforces 1 to 100 characters', () => {
    expect(validateAssetName('  Tower A ')).toEqual({ ok: true, name: 'Tower A' })
    expect(validateAssetName('   ', 'folder name')).toEqual({ ok: false, error: 'Enter a folder name' })
    expect(validateAssetName('x'.repeat(101))).toMatchObject({ ok: false })
  })
})

describe('load', () => {
  it('loads everything and becomes ready', async () => {
    const { store } = setup()
    expect(store.getState().status).toBe('idle')
    await store.getState().load()
    expect(store.getState().status).toBe('ready')
    expect(store.getState().sheets.map((s) => s.name)).toEqual(['Plan A', 'Plan B'])
  })

  it('reports a failed load, and keeps what it has when a reload fails', async () => {
    let fail = true
    const { store } = setup({ wrap: (p) => ({ ...p, loadAll: () => (fail ? Promise.reject(new Error('offline')) : p.loadAll()) }) })
    await store.getState().load()
    expect(store.getState()).toMatchObject({ status: 'error', error: 'offline' })
    fail = false
    await store.getState().load()
    expect(store.getState().status).toBe('ready')
    fail = true
    await store.getState().load()
    expect(store.getState()).toMatchObject({ status: 'ready', error: 'offline' })
  })
})

describe('workspaces and folders', () => {
  it('builds a tree, renames and deletes with the same effects the database cascades', async () => {
    const { store, sheetIds } = setup()
    const s = store.getState()
    await s.load()
    const w = ok(await s.createWorkspace(' Site 1 '))
    expect(w.name).toBe('Site 1')
    const f = ok(await s.createFolder(w.id, null, 'Civil'))
    const g = ok(await s.createFolder(w.id, f.id, 'Level 1'))
    await s.placeAsset('sheet', sheetIds[0], { spaceId: w.id, folderId: g.id })
    await s.toggleFavorite('folder', g.id)
    expect(store.getState().placements).toHaveLength(1)

    ok(await s.renameFolder(g.id, 'Level 2'))
    expect(store.getState().folders.find((x) => x.id === g.id)!.name).toBe('Level 2')

    ok(await s.deleteFolder(f.id))
    expect(store.getState().folders).toEqual([])
    expect(store.getState().placements).toEqual([])
    expect(store.getState().favorites).toEqual([])
    expect(store.getState().sheets).toHaveLength(2) // the sheet itself stays
    ok(await s.deleteWorkspace(w.id))
    expect(store.getState().workspaces).toEqual([])
    // The database agrees with the store.
    await s.load()
    expect(store.getState().folders).toEqual([])
  })

  it('checks names and nesting before calling the backend', async () => {
    const { store } = setup()
    const s = store.getState()
    await s.load()
    expect(await s.createWorkspace('  ')).toEqual({ ok: false, error: 'Enter a workspace name' })
    const w = ok(await s.createWorkspace('W'))
    let parent: string | null = null
    for (let i = 0; i < 5; i++) parent = ok(await s.createFolder(w.id, parent, `L${i}`)).id
    expect(await s.createFolder(w.id, parent, 'six')).toMatchObject({ ok: false, error: expect.stringMatching(/at most 5 levels/) })
    const top = store.getState().folders.find((f) => f.parentId === null)!
    expect(await s.moveFolder(top.id, parent)).toMatchObject({ ok: false, error: expect.stringMatching(/into itself/) })
  })

  it('moves a folder', async () => {
    const { store } = setup()
    const s = store.getState()
    await s.load()
    const w = ok(await s.createWorkspace('W'))
    const a = ok(await s.createFolder(w.id, null, 'A'))
    const b = ok(await s.createFolder(w.id, null, 'B'))
    ok(await s.moveFolder(b.id, a.id))
    expect(store.getState().folders.find((f) => f.id === b.id)!.parentId).toBe(a.id)
    ok(await s.moveFolder(b.id, null))
    expect(store.getState().folders.find((f) => f.id === b.id)!.parentId).toBeNull()
  })
})

describe('placing assets', () => {
  it('moves an asset between places and takes it out; unplaced assets show up', async () => {
    const { store, sheetIds } = setup()
    const s = store.getState()
    await s.load()
    expect(unplacedAssets(store.getState()).map((a) => a.name)).toEqual(['Plan A', 'Plan B'])
    const w1 = ok(await s.createWorkspace('One'))
    const w2 = ok(await s.createWorkspace('Two'))
    ok(await s.placeAsset('sheet', sheetIds[0], { spaceId: w1.id, folderId: null }))
    ok(await s.placeAsset('sheet', sheetIds[0], { spaceId: w2.id, folderId: null }))
    expect(store.getState().placements.map((p) => p.spaceId)).toEqual([w2.id])
    expect(unplacedAssets(store.getState()).map((a) => a.name)).toEqual(['Plan B'])
    ok(await s.placeAsset('sheet', sheetIds[0], null))
    expect(store.getState().placements).toEqual([])
  })

  it('renames a sheet', async () => {
    const { store, sheetIds, table } = setup()
    await store.getState().load()
    ok(await store.getState().renameSheet(sheetIds[0], ' Renamed '))
    expect(store.getState().sheets[0].name).toBe('Renamed')
    expect(table('sheets')[0].name).toBe('Renamed')
  })
})

describe('reports', () => {
  it('creates in a place, saves and deletes (placement and star go with it)', async () => {
    const { store } = setup()
    const s = store.getState()
    await s.load()
    const w = ok(await s.createWorkspace('W'))
    const r = ok(await s.createReport('Open tasks', emptyReportDefinition(), { spaceId: w.id, folderId: null }))
    expect(store.getState().placements).toMatchObject([{ assetType: 'report', assetId: r.id }])
    await s.toggleFavorite('report', r.id)
    ok(await s.saveReport(r.id, { name: ' Overdue ', definition: { ...emptyReportDefinition(), sources: ['x'] } }))
    expect(store.getState().reports[0]).toMatchObject({ name: 'Overdue', definition: { sources: ['x'] } })
    expect(await s.saveReport(r.id, { name: '' })).toMatchObject({ ok: false })
    ok(await s.deleteReport(r.id))
    expect([store.getState().reports, store.getState().placements, store.getState().favorites].map((x) => x.length)).toEqual([0, 0, 0])
  })
})

describe('dashboards and the autosave', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  it('applies a layout at once and saves it once after the delay, however many changes come', async () => {
    const saves: unknown[] = []
    const { store, persistence } = setup({
      saveDelayMs: 600,
      wrap: (p) => ({ ...p, saveDashboard: (id, patch) => (saves.push(patch.layout), p.saveDashboard(id, patch)) }),
    })
    const s = store.getState()
    await s.load()
    const d = ok(await s.createDashboard('Board'))
    const layout = (n: number) => ({ widgets: Array.from({ length: n }, (_, i) => newWidget('text', `w${i}`, 0, i)) })
    s.setDashboardLayout(d.id, layout(1))
    s.setDashboardLayout(d.id, layout(2))
    s.setDashboardLayout(d.id, layout(3))
    expect(store.getState().dashboards[0].layout.widgets).toHaveLength(3)
    expect(store.getState().dashboardSave).toBe('saving')
    expect(saves).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(700)
    expect(saves).toHaveLength(1)
    expect(store.getState().dashboardSave).toBe('saved')
    expect((await persistence.loadAll()).dashboards[0].layout.widgets).toHaveLength(3)
  })

  it('flush saves immediately, and a failed save is reported and retried', async () => {
    let failures = 1
    const { store } = setup({
      wrap: (p) => ({
        ...p,
        saveDashboard: (id, patch) => (patch.layout && failures-- > 0 ? Promise.reject(new Error('boom')) : p.saveDashboard(id, patch)),
      }),
    })
    const s = store.getState()
    await s.load()
    const d = ok(await s.createDashboard('Board'))
    s.setDashboardLayout(d.id, { widgets: [newWidget('title', 't')] })
    expect(await s.flush()).toBe(false)
    expect(store.getState().dashboardSave).toBe('failed')
    expect(await s.flush()).toBe(true)
    expect(store.getState().dashboardSave).toBe('saved')
  })

  it('a reload never overwrites a layout that is still waiting to be saved', async () => {
    const { store } = setup({ saveDelayMs: 10_000 })
    const s = store.getState()
    await s.load()
    const d = ok(await s.createDashboard('Board', emptyLayout()))
    s.setDashboardLayout(d.id, { widgets: [newWidget('title', 't')] })
    await s.load()
    expect(store.getState().dashboards[0].layout.widgets).toHaveLength(1)
  })

  it('renames and deletes', async () => {
    const { store } = setup()
    const s = store.getState()
    await s.load()
    const d = ok(await s.createDashboard('Board'))
    ok(await s.renameDashboard(d.id, 'Board 2'))
    expect(store.getState().dashboards[0].name).toBe('Board 2')
    ok(await s.deleteDashboard(d.id))
    expect(store.getState().dashboards).toEqual([])
  })
})

describe('favorites and search', () => {
  it('toggles a star', async () => {
    const { store, sheetIds } = setup()
    const s = store.getState()
    await s.load()
    ok(await s.toggleFavorite('sheet', sheetIds[0]))
    expect(favoriteOf(store.getState(), 'sheet', sheetIds[0])).toBeDefined()
    ok(await s.toggleFavorite('sheet', sheetIds[0]))
    expect(favoriteOf(store.getState(), 'sheet', sheetIds[0])).toBeUndefined()
  })

  it('finds assets, workspaces and folders by words in their names, best matches first', async () => {
    const { store, sheetIds } = setup()
    const s = store.getState()
    await s.load()
    const w = ok(await s.createWorkspace('Plan room'))
    const f = ok(await s.createFolder(w.id, null, 'Old plans'))
    ok(await s.createReport('Overdue plan items', emptyReportDefinition(), { spaceId: w.id, folderId: f.id }))
    await s.placeAsset('sheet', sheetIds[1], { spaceId: w.id, folderId: null })
    const hits = searchAssets(store.getState(), 'plan')
    expect(hits.map((h) => `${h.kind}:${h.name}`)).toEqual([
      'sheet:Plan A', 'sheet:Plan B', 'workspace:Plan room', 'folder:Old plans', 'report:Overdue plan items',
    ])
    expect(hits.find((h) => h.name === 'Plan B')!.where).toBe('Plan room')
    expect(hits.find((h) => h.name === 'Overdue plan items')!.where).toBe('Plan room / Old plans')
    expect(searchAssets(store.getState(), 'plan overdue').map((h) => h.name)).toEqual(['Overdue plan items'])
    expect(searchAssets(store.getState(), '   ')).toEqual([])
  })
})
