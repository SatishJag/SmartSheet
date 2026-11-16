import type { AssetType, DashboardMeta, Favorite, FavoriteKind, Folder, Placement, ReportMeta, Workspace } from './types'

/** Read-only selectors over the loaded assets: the tree, paths, favourites and search. Pure. */

export interface AssetsData {
  sheets: { id: string; name: string }[]
  workspaces: Workspace[]
  folders: Folder[]
  placements: Placement[]
  reports: ReportMeta[]
  dashboards: DashboardMeta[]
  favorites: Favorite[]
}

export interface AssetRef {
  type: AssetType
  id: string
  name: string
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

export const FOLDER_LEVELS = 5

export function allAssets(data: AssetsData): AssetRef[] {
  return [
    ...data.sheets.map((s) => ({ type: 'sheet' as const, id: s.id, name: s.name })),
    ...data.reports.map((r) => ({ type: 'report' as const, id: r.id, name: r.name })),
    ...data.dashboards.map((d) => ({ type: 'dashboard' as const, id: d.id, name: d.name })),
  ]
}

export function assetRef(data: AssetsData, type: AssetType, id: string): AssetRef | null {
  const list = type === 'sheet' ? data.sheets : type === 'report' ? data.reports : data.dashboards
  const found = list.find((x) => x.id === id)
  return found ? { type, id, name: found.name } : null
}

export const placementOf = (data: AssetsData, type: AssetType, id: string): Placement | undefined =>
  data.placements.find((p) => p.assetType === type && p.assetId === id)

/** Assets that live in no workspace, by name. */
export function unplacedAssets(data: AssetsData): AssetRef[] {
  const placed = new Set(data.placements.map((p) => `${p.assetType}:${p.assetId}`))
  return allAssets(data)
    .filter((a) => !placed.has(`${a.type}:${a.id}`))
    .sort(byName)
}

export const childFolders = (data: AssetsData, spaceId: string, parentId: string | null): Folder[] =>
  data.folders.filter((f) => f.spaceId === spaceId && f.parentId === parentId).sort(byName)

/** The assets placed directly in a workspace (folderId null) or folder, by name. */
export function itemsAt(data: AssetsData, spaceId: string, folderId: string | null): AssetRef[] {
  return data.placements
    .filter((p) => p.spaceId === spaceId && p.folderId === folderId)
    .flatMap((p) => assetRef(data, p.assetType, p.assetId) ?? [])
    .sort(byName)
}

/** The folders from the top of the workspace down to `folderId`. */
export function folderPath(data: AssetsData, folderId: string): Folder[] {
  const path: Folder[] = []
  const seen = new Set<string>()
  for (let id: string | null = folderId; id !== null && !seen.has(id); ) {
    seen.add(id)
    const f: Folder | undefined = data.folders.find((x) => x.id === id)
    if (!f) break
    path.unshift(f)
    id = f.parentId
  }
  return path
}

/** "Workspace / Folder / Subfolder" for a location. */
export function locationLabel(data: AssetsData, spaceId: string, folderId: string | null): string {
  const space = data.workspaces.find((w) => w.id === spaceId)?.name ?? 'Workspace'
  return [space, ...(folderId ? folderPath(data, folderId).map((f) => f.name) : [])].join(' / ')
}

/** Where an asset lives, as text; null when it is in no workspace. */
export function assetLocation(data: AssetsData, type: AssetType, id: string): string | null {
  const p = placementOf(data, type, id)
  return p ? locationLabel(data, p.spaceId, p.folderId) : null
}

export interface Destination {
  spaceId: string
  folderId: string | null
  label: string
  depth: number
}

/** Every place an asset can be moved to, depth first. `exceptFolderId` leaves out a folder and everything under it. */
export function destinations(data: AssetsData, exceptFolderId: string | null = null): Destination[] {
  const out: Destination[] = []
  for (const space of [...data.workspaces].sort(byName)) {
    out.push({ spaceId: space.id, folderId: null, label: space.name, depth: 0 })
    const walk = (parentId: string | null, depth: number, label: string) => {
      for (const f of childFolders(data, space.id, parentId)) {
        if (f.id === exceptFolderId) continue
        const here = `${label} / ${f.name}`
        out.push({ spaceId: space.id, folderId: f.id, label: here, depth })
        walk(f.id, depth + 1, here)
      }
    }
    walk(null, 1, space.name)
  }
  return out
}

/** How many levels of folders sit below `folderId` (0 for a folder with no subfolders). */
export function folderHeight(data: AssetsData, folderId: string): number {
  const kids = data.folders.filter((f) => f.parentId === folderId)
  return kids.length === 0 ? 0 : 1 + Math.max(...kids.map((k) => folderHeight(data, k.id)))
}

/** Folders a given folder could move under without breaking the nesting limit or its own subtree. */
export function folderMoveTargets(data: AssetsData, folderId: string): Destination[] {
  const folder = data.folders.find((f) => f.id === folderId)
  if (!folder) return []
  const height = folderHeight(data, folderId)
  return destinations(data, folderId).filter(
    (d) => d.spaceId === folder.spaceId && (d.folderId === null || folderPath(data, d.folderId).length + 1 + height <= FOLDER_LEVELS),
  )
}

export const favoriteOf = (data: AssetsData, kind: FavoriteKind, id: string): Favorite | undefined =>
  data.favorites.find((f) => f.kind === kind && f.targetId === id)

export interface SearchHit {
  kind: FavoriteKind
  id: string
  name: string
  /** Where it lives ("Not in a workspace" for an unplaced asset). */
  where: string
}

/** Names containing every word of the query, best match first (prefix, then word start, then anywhere). */
export function searchAssets(data: AssetsData, query: string, limit = 50): SearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const candidates: SearchHit[] = [
    ...allAssets(data).map((a) => ({ kind: a.type as FavoriteKind, id: a.id, name: a.name, where: assetLocation(data, a.type, a.id) ?? 'Not in a workspace' })),
    ...data.workspaces.map((w) => ({ kind: 'workspace' as const, id: w.id, name: w.name, where: 'Workspace' })),
    ...data.folders.map((f) => ({ kind: 'folder' as const, id: f.id, name: f.name, where: locationLabel(data, f.spaceId, f.parentId) })),
  ]
  const scored: { hit: SearchHit; score: number }[] = []
  for (const hit of candidates) {
    const name = hit.name.toLowerCase()
    if (!words.every((w) => name.includes(w))) continue
    const score = name.startsWith(words[0]) ? 0 : words.every((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(name)) ? 1 : 2
    scored.push({ hit, score })
  }
  return scored.sort((a, b) => a.score - b.score || byName(a.hit, b.hit)).slice(0, limit).map((s) => s.hit)
}
