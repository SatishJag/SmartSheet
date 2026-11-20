/**
 * The smart-assets tables of the fake backend (supabase/migrations/0008_assets.sql): workspaces,
 * folders, reports, dashboards, workspace_items and favorites. Kept in its own file so the fake's
 * core stays small; fakeSupabase.ts calls the hooks below. Mirrors the migration's constraints:
 * name lengths, json object limits, composite same-owner keys (modelled as "the parent exists and
 * is the caller's"), one placement per asset, one star per target, folder nesting (5 levels, no
 * cycles, a folder never changes workspace), derived `asset_type` / `kind`, and cascade deletes.
 */
import type { DbRecord, FakeError } from './fakeSupabase'

export const ASSET_TABLES = ['workspaces', 'folders', 'reports', 'dashboards', 'workspace_items', 'favorites'] as const
export type AssetTable = (typeof ASSET_TABLES)[number]

export const isAssetTable = (t: string): t is AssetTable => (ASSET_TABLES as readonly string[]).includes(t)

interface Spec {
  default?: (ctx: { uid: string; now: () => string }) => unknown
  notNull?: boolean
}
const id: Spec = { default: () => crypto.randomUUID(), notNull: true }
const owner: Spec = { default: ({ uid }) => uid, notNull: true }
const created: Spec = { default: ({ now }) => now(), notNull: true }
const nullable: Spec = { default: () => null }

export const ASSET_SCHEMA: Record<AssetTable, Record<string, Spec>> = {
  workspaces: { id, owner_id: owner, workspace_id: owner, name: { notNull: true }, created_at: created },
  folders: {
    id, owner_id: owner, workspace_id: owner, space_id: { notNull: true }, parent_id: nullable,
    name: { notNull: true }, position: { default: () => 0, notNull: true }, created_at: created,
  },
  reports: {
    id, owner_id: owner, workspace_id: owner, name: { notNull: true },
    definition: { default: () => ({}), notNull: true }, created_at: created, updated_at: created,
  },
  dashboards: {
    id, owner_id: owner, workspace_id: owner, name: { notNull: true },
    layout: { default: () => ({}), notNull: true }, created_at: created, updated_at: created,
  },
  workspace_items: {
    id, owner_id: owner, workspace_id: owner, space_id: { notNull: true }, folder_id: nullable,
    sheet_id: nullable, report_id: nullable, dashboard_id: nullable, asset_type: { notNull: true },
    position: { default: () => 0, notNull: true }, created_at: created,
  },
  favorites: {
    id, owner_id: owner, workspace_id: owner, sheet_id: nullable, report_id: nullable, dashboard_id: nullable,
    space_id: nullable, folder_id: nullable, kind: { notNull: true }, created_at: created,
  },
}

export function emptyAssetTables(): Record<AssetTable, DbRecord[]> {
  return { workspaces: [], folders: [], reports: [], dashboards: [], workspace_items: [], favorites: [] }
}

type Tables = Record<string, DbRecord[]>
interface StateLike {
  tables: Tables
}

const pg = (message: string, code: string): FakeError => ({ message, code, details: null, hint: null })
const check = (message: string) => pg(message, '23514')
const fk = (table: string) => pg(`insert or update on table "${table}" violates foreign key constraint`, '23503')
const MAX_JSON = 262_144
const MAX_FOLDER_LEVELS = 5

/** Fills the generated columns (`asset_type`, `kind`) from the target columns. */
export function computeGenerated(table: string, row: DbRecord): void {
  if (table === 'workspace_items') row.asset_type = row.sheet_id != null ? 'sheet' : row.report_id != null ? 'report' : 'dashboard'
  if (table === 'favorites') {
    row.kind =
      row.sheet_id != null ? 'sheet' : row.report_id != null ? 'report' : row.dashboard_id != null ? 'dashboard' : row.space_id != null ? 'workspace' : 'folder'
  }
}

const owns = (state: StateLike, table: string, rowId: unknown, uid: string, extra: (r: DbRecord) => boolean = () => true) =>
  state.tables[table].some((r) => r.id === rowId && r.owner_id === uid && extra(r))

function jsonOk(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && JSON.stringify(v).length <= MAX_JSON
}

/** Levels above `parentId` (inclusive of the parent chain), and whether `selfId` is among them. */
function ancestors(folders: DbRecord[], parentId: unknown, selfId: unknown): { levels: number; cycle: boolean } {
  let levels = 0
  let cur = parentId
  while (cur != null && levels < 50) {
    if (cur === selfId) return { levels, cycle: true }
    const f = folders.find((x) => x.id === cur)
    if (!f) break
    levels++
    cur = f.parent_id
  }
  return { levels, cycle: false }
}

function subtreeHeight(folders: DbRecord[], id: unknown): number {
  const kids = folders.filter((f) => f.parent_id === id)
  return kids.length === 0 ? 0 : 1 + Math.max(...kids.map((k) => subtreeHeight(folders, k.id)))
}

/** RLS `with check` plus constraints and keys of the asset tables. Null when the row is fine. */
export function assetRowError(table: AssetTable, state: StateLike, uid: string, row: DbRecord): FakeError | null {
  const name = row.name
  if (table !== 'workspace_items' && table !== 'favorites') {
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) return check(`new row for relation "${table}" violates check constraint "${table}_name_check"`)
  }
  if (table === 'reports' && !jsonOk(row.definition)) return check('new row for relation "reports" violates check constraint "reports_definition_check"')
  if (table === 'dashboards' && !jsonOk(row.layout)) return check('new row for relation "dashboards" violates check constraint "dashboards_layout_check"')
  if (table === 'folders') {
    if (!owns(state, 'workspaces', row.space_id, uid)) return fk('folders')
    if (row.parent_id === row.id) return check('new row for relation "folders" violates check constraint "folders_check"')
    if (row.parent_id != null && !owns(state, 'folders', row.parent_id, uid, (p) => p.space_id === row.space_id)) return fk('folders')
    const others = state.tables.folders.filter((f) => f.id !== row.id)
    const up = ancestors(others, row.parent_id, row.id)
    if (up.cycle) return check('a folder cannot be moved into itself or one of its subfolders')
    if (up.levels + 1 + subtreeHeight(others, row.id) > MAX_FOLDER_LEVELS) return check('folders can be nested at most 5 levels deep')
  }
  if (table === 'workspace_items') {
    const targets = [row.sheet_id, row.report_id, row.dashboard_id].filter((v) => v != null)
    if (targets.length !== 1) return check('new row for relation "workspace_items" violates check constraint "workspace_items_check"')
    if (!owns(state, 'workspaces', row.space_id, uid)) return fk('workspace_items')
    if (row.folder_id != null && !owns(state, 'folders', row.folder_id, uid, (f) => f.space_id === row.space_id)) return fk('workspace_items')
    if (row.sheet_id != null && !owns(state, 'sheets', row.sheet_id, uid)) return fk('workspace_items')
    if (row.report_id != null && !owns(state, 'reports', row.report_id, uid)) return fk('workspace_items')
    if (row.dashboard_id != null && !owns(state, 'dashboards', row.dashboard_id, uid)) return fk('workspace_items')
  }
  if (table === 'favorites') {
    const cols: [string, string][] = [['sheet_id', 'sheets'], ['report_id', 'reports'], ['dashboard_id', 'dashboards'], ['space_id', 'workspaces'], ['folder_id', 'folders']]
    if (cols.filter(([c]) => row[c] != null).length !== 1) return check('new row for relation "favorites" violates check constraint "favorites_check"')
    for (const [c, t] of cols) if (row[c] != null && !owns(state, t, row[c], uid)) return fk('favorites')
  }
  return null
}

/** Unique keys: one placement per asset; one star per (owner, target). Null when `row` is unique among `others`. */
export function assetUniqueError(table: AssetTable, row: DbRecord, others: DbRecord[]): FakeError | null {
  const dup = (cols: string[]) =>
    cols.some((c) => row[c] != null && others.some((o) => o !== row && o.id !== row.id && o[c] === row[c] && (table !== 'favorites' || o.owner_id === row.owner_id)))
  if (table === 'workspace_items' && dup(['sheet_id', 'report_id', 'dashboard_id'])) {
    return pg('duplicate key value violates unique constraint "workspace_items_asset_key"', '23505')
  }
  if (table === 'favorites' && dup(['sheet_id', 'report_id', 'dashboard_id', 'space_id', 'folder_id'])) {
    return pg('duplicate key value violates unique constraint "favorites_owner_target_key"', '23505')
  }
  return null
}

/** What an UPDATE does besides the patch: stamp `updated_at`, and refuse a folder changing workspace. */
export function beforeAssetUpdate(table: AssetTable, old: DbRecord, next: DbRecord, now: () => string): FakeError | null {
  if (table === 'folders' && next.space_id !== old.space_id) return check('a folder cannot change workspace')
  if (table === 'reports' || table === 'dashboards') next.updated_at = now()
  computeGenerated(table, next)
  return null
}

/** Deletes rows of an asset table or an asset's placement / stars after it is deleted. Mirrors the `on delete cascade` keys. */
export function cascadeAssets(state: StateLike, table: string, ids: Set<unknown>): void {
  const t = state.tables
  const drop = (name: string, test: (r: DbRecord) => boolean) => {
    t[name] = (t[name] ?? []).filter((r) => !test(r))
  }
  if (table === 'sheets') {
    drop('workspace_items', (r) => ids.has(r.sheet_id))
    drop('favorites', (r) => ids.has(r.sheet_id))
  } else if (table === 'reports' || table === 'dashboards') {
    const col = table === 'reports' ? 'report_id' : 'dashboard_id'
    drop(table, (r) => ids.has(r.id))
    drop('workspace_items', (r) => ids.has(r[col]))
    drop('favorites', (r) => ids.has(r[col]))
  } else if (table === 'folders') {
    const all = new Set(ids)
    for (let grew = true; grew; ) {
      grew = false
      for (const f of t.folders) {
        if (f.parent_id != null && all.has(f.parent_id) && !all.has(f.id)) {
          all.add(f.id)
          grew = true
        }
      }
    }
    drop('folders', (r) => all.has(r.id))
    drop('workspace_items', (r) => all.has(r.folder_id))
    drop('favorites', (r) => all.has(r.folder_id))
  } else if (table === 'workspaces') {
    drop('workspaces', (r) => ids.has(r.id))
    drop('folders', (r) => ids.has(r.space_id))
    drop('workspace_items', (r) => ids.has(r.space_id))
    drop('favorites', (r) => ids.has(r.space_id))
  } else {
    drop(table, (r) => ids.has(r.id))
  }
}
