import { createStore, type StoreApi } from 'zustand/vanilla'
import type { SupabaseClient } from '@supabase/supabase-js'
import { folderHeight, FOLDER_LEVELS, folderPath, favoriteOf, type AssetsData } from './assetModel'
import { supabaseAssetsPersistence, type AssetsPersistence, type PlaceAt } from './assetsApi'
import { emptyLayout, emptyReportDefinition } from './definition'
import type {
  AssetType,
  DashboardLayout,
  DashboardMeta,
  FavoriteKind,
  Folder,
  Placement,
  ReportDefinition,
  ReportMeta,
  Workspace,
} from './types'

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string }

export const MAX_NAME_LENGTH = 100

/** An asset name as typed: trimmed, 1 to 100 characters. */
export function validateAssetName(raw: string, what = 'name'): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.trim()
  if (name === '') return { ok: false, error: `Enter a ${what}` }
  if (name.length > MAX_NAME_LENGTH) return { ok: false, error: `The ${what} can be at most ${MAX_NAME_LENGTH} characters` }
  return { ok: true, name }
}

export type DashboardSaveStatus = 'saved' | 'saving' | 'failed'

export interface AssetsState extends AssetsData {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  /** State of the dashboard layout autosave. */
  dashboardSave: DashboardSaveStatus

  load(): Promise<void>

  createWorkspace(name: string): Promise<Result<Workspace>>
  renameWorkspace(id: string, name: string): Promise<Result>
  deleteWorkspace(id: string): Promise<Result>
  createFolder(spaceId: string, parentId: string | null, name: string): Promise<Result<Folder>>
  renameFolder(id: string, name: string): Promise<Result>
  moveFolder(id: string, parentId: string | null): Promise<Result>
  deleteFolder(id: string): Promise<Result>
  /** Puts an asset in a workspace or folder; `null` takes it out of any workspace. */
  placeAsset(type: AssetType, id: string, at: PlaceAt | null): Promise<Result>
  renameSheet(id: string, name: string): Promise<Result>

  createReport(name: string, definition?: ReportDefinition, at?: PlaceAt | null): Promise<Result<ReportMeta>>
  saveReport(id: string, patch: { name?: string; definition?: ReportDefinition }): Promise<Result>
  deleteReport(id: string): Promise<Result>

  createDashboard(name: string, layout?: DashboardLayout, at?: PlaceAt | null): Promise<Result<DashboardMeta>>
  renameDashboard(id: string, name: string): Promise<Result>
  /** Applies the layout at once and saves it a moment later (so dragging does not save on every pixel). */
  setDashboardLayout(id: string, layout: DashboardLayout): void
  deleteDashboard(id: string): Promise<Result>

  toggleFavorite(kind: FavoriteKind, id: string): Promise<Result>
  /** Saves any pending dashboard layout now. Resolves false when a save failed. */
  flush(): Promise<boolean>
}

export interface AssetsStoreOptions {
  /** How long a dashboard layout change waits before it is saved. */
  saveDelayMs?: number
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function createAssetsStore(p: AssetsPersistence, opts: AssetsStoreOptions = {}): StoreApi<AssetsState> {
  const saveDelay = opts.saveDelayMs ?? 600
  const dirty = new Map<string, DashboardLayout>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let flushing: Promise<boolean> | null = null

  return createStore<AssetsState>()((set, get) => {
    /** Runs a persistence call; on success applies `apply` to the state. Never throws. */
    async function run<T>(call: () => Promise<T>, apply: (value: T) => void): Promise<Result<T>> {
      try {
        const value = await call()
        apply(value)
        return { ok: true, value }
      } catch (e) {
        return { ok: false, error: message(e) }
      }
    }
    const named = (raw: string, what: string) => validateAssetName(raw, what)

    function dropAssetRefs(type: AssetType, id: string): void {
      const fav = (f: { kind: FavoriteKind; targetId: string }) => f.kind === type && f.targetId === id
      set((s) => ({
        placements: s.placements.filter((pl) => !(pl.assetType === type && pl.assetId === id)),
        favorites: s.favorites.filter((f) => !fav(f)),
      }))
    }

    async function flush(): Promise<boolean> {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (flushing) await flushing
      if (dirty.size === 0) return get().dashboardSave !== 'failed'
      flushing = (async () => {
        set({ dashboardSave: 'saving' })
        let ok = true
        for (const [id, layout] of [...dirty]) {
          try {
            const { updatedAt } = await p.saveDashboard(id, { layout })
            // A newer layout may have arrived while saving: keep it queued.
            if (dirty.get(id) === layout) dirty.delete(id)
            set((s) => ({ dashboards: s.dashboards.map((d) => (d.id === id ? { ...d, updatedAt } : d)) }))
          } catch {
            ok = false
          }
        }
        set({ dashboardSave: ok && dirty.size === 0 ? 'saved' : ok ? 'saving' : 'failed' })
        flushing = null
        if (ok && dirty.size > 0) return flush()
        return ok
      })()
      return flushing
    }

    return {
      sheets: [],
      workspaces: [],
      folders: [],
      placements: [],
      reports: [],
      dashboards: [],
      favorites: [],
      status: 'idle',
      error: null,
      dashboardSave: 'saved',

      async load() {
        // Never replace what the user just changed with an older copy from the server.
        await flush()
        if (get().status === 'idle') set({ status: 'loading' })
        try {
          const snap = await p.loadAll()
          set({ ...snap, status: 'ready', error: null })
        } catch (e) {
          set(get().status === 'ready' ? { error: message(e) } : { status: 'error', error: message(e) })
        }
      },

      async createWorkspace(raw) {
        const v = named(raw, 'workspace name')
        if (!v.ok) return v
        return run(() => p.createWorkspace(v.name), (w) => set((s) => ({ workspaces: [...s.workspaces, w] })))
      },
      async renameWorkspace(id, raw) {
        const v = named(raw, 'workspace name')
        if (!v.ok) return v
        return run(() => p.renameWorkspace(id, v.name), () => set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name: v.name } : w)) })))
      },
      async deleteWorkspace(id) {
        return run(() => p.deleteWorkspace(id), () => {
          // The database cascades: the folders and placements go, the assets stay (now in no workspace).
          const folderIds = new Set(get().folders.filter((f) => f.spaceId === id).map((f) => f.id))
          set((s) => ({
            workspaces: s.workspaces.filter((w) => w.id !== id),
            folders: s.folders.filter((f) => f.spaceId !== id),
            placements: s.placements.filter((pl) => pl.spaceId !== id),
            favorites: s.favorites.filter((f) => !(f.kind === 'workspace' && f.targetId === id) && !(f.kind === 'folder' && folderIds.has(f.targetId))),
          }))
        })
      },

      async createFolder(spaceId, parentId, raw) {
        const v = named(raw, 'folder name')
        if (!v.ok) return v
        if (parentId && folderPath(get(), parentId).length >= FOLDER_LEVELS) {
          return { ok: false, error: `Folders can be nested at most ${FOLDER_LEVELS} levels deep` }
        }
        return run(() => p.createFolder(spaceId, parentId, v.name), (f) => set((s) => ({ folders: [...s.folders, f] })))
      },
      async renameFolder(id, raw) {
        const v = named(raw, 'folder name')
        if (!v.ok) return v
        return run(() => p.renameFolder(id, v.name), () => set((s) => ({ folders: s.folders.map((f) => (f.id === id ? { ...f, name: v.name } : f)) })))
      },
      async moveFolder(id, parentId) {
        if (parentId) {
          if (parentId === id || folderPath(get(), parentId).some((f) => f.id === id)) return { ok: false, error: 'A folder cannot be moved into itself or one of its subfolders' }
          if (folderPath(get(), parentId).length + 1 + folderHeight(get(), id) > FOLDER_LEVELS) {
            return { ok: false, error: `Folders can be nested at most ${FOLDER_LEVELS} levels deep` }
          }
        }
        return run(() => p.moveFolder(id, parentId), () => set((s) => ({ folders: s.folders.map((f) => (f.id === id ? { ...f, parentId } : f)) })))
      },
      async deleteFolder(id) {
        return run(() => p.deleteFolder(id), () => {
          const doomed = new Set([id])
          for (let grew = true; grew; ) {
            grew = false
            for (const f of get().folders) {
              if (f.parentId && doomed.has(f.parentId) && !doomed.has(f.id)) {
                doomed.add(f.id)
                grew = true
              }
            }
          }
          set((s) => ({
            folders: s.folders.filter((f) => !doomed.has(f.id)),
            placements: s.placements.filter((pl) => !(pl.folderId && doomed.has(pl.folderId))),
            favorites: s.favorites.filter((f) => !(f.kind === 'folder' && doomed.has(f.targetId))),
          }))
        })
      },

      async placeAsset(type, id, at) {
        const res = await run(() => p.placeAsset(type, id, at), (placement: Placement | null) =>
          set((s) => {
            const rest = s.placements.filter((pl) => !(pl.assetType === type && pl.assetId === id))
            return { placements: placement ? [...rest, placement] : rest }
          }),
        )
        return res.ok ? { ok: true, value: undefined } : res
      },
      async renameSheet(id, raw) {
        const v = named(raw, 'sheet name')
        if (!v.ok) return v
        return run(() => p.renameSheet(id, v.name), () => set((s) => ({ sheets: s.sheets.map((x) => (x.id === id ? { ...x, name: v.name } : x)) })))
      },

      async createReport(raw, definition = emptyReportDefinition(), at = null) {
        const v = named(raw, 'report name')
        if (!v.ok) return v
        const made = await run(() => p.createReport(v.name, definition), (r) => set((s) => ({ reports: [...s.reports, r] })))
        if (made.ok && at) await get().placeAsset('report', made.value.id, at)
        return made
      },
      async saveReport(id, patch) {
        if (patch.name !== undefined) {
          const v = named(patch.name, 'report name')
          if (!v.ok) return v
          patch = { ...patch, name: v.name }
        }
        return run(() => p.saveReport(id, patch), ({ updatedAt }) =>
          set((s) => ({
            reports: s.reports.map((r) =>
              r.id === id ? { ...r, name: patch.name ?? r.name, definition: patch.definition ?? r.definition, updatedAt } : r,
            ),
          })),
        ).then((r) => (r.ok ? { ok: true as const, value: undefined } : r))
      },
      async deleteReport(id) {
        return run(() => p.deleteReport(id), () => {
          set((s) => ({ reports: s.reports.filter((r) => r.id !== id) }))
          dropAssetRefs('report', id)
        })
      },

      async createDashboard(raw, layout = emptyLayout(), at = null) {
        const v = named(raw, 'dashboard name')
        if (!v.ok) return v
        const made = await run(() => p.createDashboard(v.name, layout), (d) => set((s) => ({ dashboards: [...s.dashboards, d] })))
        if (made.ok && at) await get().placeAsset('dashboard', made.value.id, at)
        return made
      },
      async renameDashboard(id, raw) {
        const v = named(raw, 'dashboard name')
        if (!v.ok) return v
        return run(() => p.saveDashboard(id, { name: v.name }), ({ updatedAt }) =>
          set((s) => ({ dashboards: s.dashboards.map((d) => (d.id === id ? { ...d, name: v.name, updatedAt } : d)) })),
        ).then((r) => (r.ok ? { ok: true as const, value: undefined } : r))
      },
      setDashboardLayout(id, layout) {
        if (!get().dashboards.some((d) => d.id === id)) return
        dirty.set(id, layout)
        set((s) => ({ dashboards: s.dashboards.map((d) => (d.id === id ? { ...d, layout } : d)), dashboardSave: 'saving' }))
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => void flush(), saveDelay)
      },
      async deleteDashboard(id) {
        dirty.delete(id)
        return run(() => p.deleteDashboard(id), () => {
          set((s) => ({ dashboards: s.dashboards.filter((d) => d.id !== id) }))
          dropAssetRefs('dashboard', id)
        })
      },

      async toggleFavorite(kind, id) {
        const existing = favoriteOf(get(), kind, id)
        if (existing) {
          return run(() => p.removeFavorite(existing.id), () => set((s) => ({ favorites: s.favorites.filter((f) => f.id !== existing.id) })))
        }
        return run(() => p.addFavorite(kind, id), (f) => set((s) => ({ favorites: [...s.favorites, f] }))).then((r) => (r.ok ? { ok: true as const, value: undefined } : r))
      },

      flush,
    }
  })
}

// ---- one store per backend client, shared by the three pages ----

const stores = new WeakMap<SupabaseClient, StoreApi<AssetsState>>()

/** The assets store of a client, created on first use and kept, so the pages share data and pending saves. */
export function assetsStoreFor(client: SupabaseClient): StoreApi<AssetsState> {
  let store = stores.get(client)
  if (!store) {
    store = createAssetsStore(supabaseAssetsPersistence(client))
    stores.set(client, store)
  }
  return store
}
