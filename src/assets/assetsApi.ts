import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllPages } from '../store/paging'
import { parseDashboardLayout, parseReportDefinition } from './definition'
import type {
  AssetType,
  DashboardLayout,
  DashboardMeta,
  Favorite,
  FavoriteKind,
  Folder,
  Placement,
  ReportDefinition,
  ReportMeta,
  Workspace,
} from './types'

/**
 * Persistence of the smart assets (tables of supabase/migrations/0008_assets.sql). The interface is
 * what the store and the tests depend on; `supabaseAssetsPersistence` implements it over the client.
 * Row-level security means every read returns only the caller's rows, so no owner filters are needed.
 */

export interface SheetRef {
  id: string
  name: string
  createdAt: string
}

export interface AssetsSnapshot {
  sheets: SheetRef[]
  workspaces: Workspace[]
  folders: Folder[]
  placements: Placement[]
  reports: ReportMeta[]
  dashboards: DashboardMeta[]
  favorites: Favorite[]
}

export interface PlaceAt {
  spaceId: string
  folderId: string | null
}

export interface AssetsPersistence {
  loadAll(): Promise<AssetsSnapshot>
  createWorkspace(name: string): Promise<Workspace>
  renameWorkspace(id: string, name: string): Promise<void>
  deleteWorkspace(id: string): Promise<void>
  createFolder(spaceId: string, parentId: string | null, name: string): Promise<Folder>
  renameFolder(id: string, name: string): Promise<void>
  /** Moves a folder under another folder of the same workspace (null = the workspace's top level). */
  moveFolder(id: string, parentId: string | null): Promise<void>
  deleteFolder(id: string): Promise<void>
  /** Puts an asset in a workspace / folder (or moves it); `null` takes it out of any workspace. */
  placeAsset(type: AssetType, assetId: string, at: PlaceAt | null): Promise<Placement | null>
  renameSheet(id: string, name: string): Promise<void>
  createReport(name: string, definition: ReportDefinition): Promise<ReportMeta>
  saveReport(id: string, patch: { name?: string; definition?: ReportDefinition }): Promise<{ updatedAt: string }>
  deleteReport(id: string): Promise<void>
  createDashboard(name: string, layout: DashboardLayout): Promise<DashboardMeta>
  saveDashboard(id: string, patch: { name?: string; layout?: DashboardLayout }): Promise<{ updatedAt: string }>
  deleteDashboard(id: string): Promise<void>
  addFavorite(kind: FavoriteKind, targetId: string): Promise<Favorite>
  removeFavorite(id: string): Promise<void>
}

// ---- DB row shapes ----

interface DbWorkspace {
  id: string
  name: string
  created_at: string
}
interface DbFolder {
  id: string
  space_id: string
  parent_id: string | null
  name: string
  position: number
}
interface DbItem {
  id: string
  space_id: string
  folder_id: string | null
  sheet_id: string | null
  report_id: string | null
  dashboard_id: string | null
  asset_type: AssetType
  position: number
}
interface DbReport {
  id: string
  name: string
  definition: unknown
  updated_at: string
}
interface DbDashboard {
  id: string
  name: string
  layout: unknown
  updated_at: string
}
interface DbFavorite {
  id: string
  kind: FavoriteKind
  sheet_id: string | null
  report_id: string | null
  dashboard_id: string | null
  space_id: string | null
  folder_id: string | null
}

// ---- pure mappers ----

export const workspaceFromDb = (r: DbWorkspace): Workspace => ({ id: r.id, name: r.name, createdAt: r.created_at })

export const folderFromDb = (r: DbFolder): Folder => ({ id: r.id, spaceId: r.space_id, parentId: r.parent_id, name: r.name, position: r.position })

const ASSET_COLUMN: Record<AssetType, 'sheet_id' | 'report_id' | 'dashboard_id'> = {
  sheet: 'sheet_id',
  report: 'report_id',
  dashboard: 'dashboard_id',
}

export function placementFromDb(r: DbItem): Placement {
  const assetType = r.asset_type
  return {
    id: r.id,
    spaceId: r.space_id,
    folderId: r.folder_id,
    assetType,
    assetId: r[ASSET_COLUMN[assetType]] as string,
    position: r.position,
  }
}

export const reportFromDb = (r: DbReport): ReportMeta => ({
  id: r.id,
  name: r.name,
  definition: parseReportDefinition(r.definition),
  updatedAt: r.updated_at,
})

export const dashboardFromDb = (r: DbDashboard): DashboardMeta => ({
  id: r.id,
  name: r.name,
  layout: parseDashboardLayout(r.layout),
  updatedAt: r.updated_at,
})

const FAVORITE_COLUMN: Record<FavoriteKind, 'sheet_id' | 'report_id' | 'dashboard_id' | 'space_id' | 'folder_id'> = {
  sheet: 'sheet_id',
  report: 'report_id',
  dashboard: 'dashboard_id',
  workspace: 'space_id',
  folder: 'folder_id',
}

/** The three asset columns of `workspace_items` with only the given asset's set. */
const assetColumns = (type: AssetType, id: string) => ({
  sheet_id: type === 'sheet' ? id : null,
  report_id: type === 'report' ? id : null,
  dashboard_id: type === 'dashboard' ? id : null,
})

/** The five target columns of `favorites` with only the given target's set. */
const favoriteColumns = (kind: FavoriteKind, id: string) => ({
  sheet_id: kind === 'sheet' ? id : null,
  report_id: kind === 'report' ? id : null,
  dashboard_id: kind === 'dashboard' ? id : null,
  space_id: kind === 'workspace' ? id : null,
  folder_id: kind === 'folder' ? id : null,
})

export const favoriteFromDb = (r: DbFavorite): Favorite => ({ id: r.id, kind: r.kind, targetId: r[FAVORITE_COLUMN[r.kind]] as string })

/** Throws the Supabase error (if any) as an Error, otherwise returns the data. */
function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data
}

export function supabaseAssetsPersistence(client: SupabaseClient): AssetsPersistence {
  const page = <T extends { id: string }>(table: string, columns: string, order: string) =>
    fetchAllPages<T>((from, to) =>
      client.from(table).select(columns).order(order).order('id').range(from, to) as unknown as PromiseLike<{
        data: T[] | null
        error: { message: string } | null
      }>,
    )

  return {
    async loadAll() {
      const [sheets, workspaces, folders, items, reports, dashboards, favorites] = await Promise.all([
        page<{ id: string; name: string; created_at: string }>('sheets', 'id, name, created_at', 'created_at'),
        page<DbWorkspace>('workspaces', 'id, name, created_at', 'created_at'),
        page<DbFolder>('folders', 'id, space_id, parent_id, name, position', 'position'),
        page<DbItem>('workspace_items', '*', 'position'),
        page<DbReport>('reports', 'id, name, definition, updated_at', 'created_at'),
        page<DbDashboard>('dashboards', 'id, name, layout, updated_at', 'created_at'),
        page<DbFavorite>('favorites', '*', 'created_at'),
      ])
      return {
        sheets: sheets.map((s) => ({ id: s.id, name: s.name, createdAt: s.created_at })),
        workspaces: workspaces.map(workspaceFromDb),
        folders: folders.map(folderFromDb),
        placements: items.map(placementFromDb),
        reports: reports.map(reportFromDb),
        dashboards: dashboards.map(dashboardFromDb),
        favorites: favorites.map(favoriteFromDb),
      }
    },

    async createWorkspace(name) {
      return workspaceFromDb(check(await client.from('workspaces').insert({ name }).select('id, name, created_at').single()) as DbWorkspace)
    },
    async renameWorkspace(id, name) {
      check(await client.from('workspaces').update({ name }).eq('id', id))
    },
    async deleteWorkspace(id) {
      check(await client.from('workspaces').delete().eq('id', id))
    },

    async createFolder(spaceId, parentId, name) {
      const row = check(
        await client.from('folders').insert({ space_id: spaceId, parent_id: parentId, name }).select('id, space_id, parent_id, name, position').single(),
      ) as DbFolder
      return folderFromDb(row)
    },
    async renameFolder(id, name) {
      check(await client.from('folders').update({ name }).eq('id', id))
    },
    async moveFolder(id, parentId) {
      check(await client.from('folders').update({ parent_id: parentId }).eq('id', id))
    },
    async deleteFolder(id) {
      check(await client.from('folders').delete().eq('id', id))
    },

    async placeAsset(type, assetId, at) {
      const col = ASSET_COLUMN[type]
      if (at === null) {
        check(await client.from('workspace_items').delete().eq(col, assetId))
        return null
      }
      const existing = check(await client.from('workspace_items').select('id').eq(col, assetId)) as { id: string }[]
      if (existing.length > 0) {
        const row = check(
          await client.from('workspace_items').update({ space_id: at.spaceId, folder_id: at.folderId }).eq('id', existing[0].id).select('*').single(),
        ) as DbItem
        return placementFromDb(row)
      }
      const row = check(
        await client
          .from('workspace_items')
          .insert({ space_id: at.spaceId, folder_id: at.folderId, ...assetColumns(type, assetId) })
          .select('*')
          .single(),
      ) as DbItem
      return placementFromDb(row)
    },

    async renameSheet(id, name) {
      check(await client.from('sheets').update({ name }).eq('id', id))
    },

    async createReport(name, definition) {
      return reportFromDb(
        check(await client.from('reports').insert({ name, definition }).select('id, name, definition, updated_at').single()) as DbReport,
      )
    },
    async saveReport(id, patch) {
      const row = check(
        await client
          .from('reports')
          .update({ ...(patch.name !== undefined && { name: patch.name }), ...(patch.definition !== undefined && { definition: patch.definition }) })
          .eq('id', id)
          .select('updated_at')
          .single(),
      ) as { updated_at: string }
      return { updatedAt: row.updated_at }
    },
    async deleteReport(id) {
      check(await client.from('reports').delete().eq('id', id))
    },

    async createDashboard(name, layout) {
      return dashboardFromDb(
        check(await client.from('dashboards').insert({ name, layout }).select('id, name, layout, updated_at').single()) as DbDashboard,
      )
    },
    async saveDashboard(id, patch) {
      const row = check(
        await client
          .from('dashboards')
          .update({ ...(patch.name !== undefined && { name: patch.name }), ...(patch.layout !== undefined && { layout: patch.layout }) })
          .eq('id', id)
          .select('updated_at')
          .single(),
      ) as { updated_at: string }
      return { updatedAt: row.updated_at }
    },
    async deleteDashboard(id) {
      check(await client.from('dashboards').delete().eq('id', id))
    },

    async addFavorite(kind, targetId) {
      return favoriteFromDb(check(await client.from('favorites').insert(favoriteColumns(kind, targetId)).select('*').single()) as DbFavorite)
    },
    async removeFavorite(id) {
      check(await client.from('favorites').delete().eq('id', id))
    },
  }
}
