import { useMemo, useState } from 'react'
import { DEFAULT_TEMPLATE_ID } from '../templates'
import { insertSheetFromTemplate } from '../templates/insertTemplate'
import { useShell } from '../shell/ShellContext'
import { ConfirmDialog } from '../views/ConfirmDialog'
import { assetRef, childFolders, favoriteOf, itemsAt, searchAssets, unplacedAssets, type AssetRef, type SearchHit } from './assetModel'
import { ActionMenu, type MenuItem } from './ActionMenu'
import { AssetIcon, ASSET_ICON, ASSET_LABEL } from './AssetIcon'
import { validateAssetName } from './assetsStore'
import { useAssetViewer } from './AssetViewer'
import { MoveDialog } from './MoveDialog'
import { PromptDialog } from './PromptDialog'
import { readRecent } from './recent'
import type { AssetType, Favorite, FavoriteKind, Folder, Workspace } from './types'
import { useAssets, useAssetsApi, useLoadAssets } from './useAssets'

type Pending =
  | { kind: 'new-workspace' }
  | { kind: 'new-folder'; spaceId: string; parentId: string | null }
  | { kind: 'new-report'; spaceId: string; folderId: string | null }
  | { kind: 'new-dashboard'; spaceId: string; folderId: string | null }
  | { kind: 'rename-workspace'; id: string; name: string }
  | { kind: 'rename-folder'; id: string; name: string }
  | { kind: 'rename-asset'; type: AssetType; id: string; name: string }
  | { kind: 'delete-workspace'; id: string; name: string }
  | { kind: 'delete-folder'; id: string; name: string }
  | { kind: 'move-asset'; type: AssetType; id: string; name: string }
  | { kind: 'move-folder'; id: string; name: string }

/** Workspaces: shared containers for your sheets, reports and dashboards, with folders, favorites, recents and search. */
export function WorkspacesPage() {
  useLoadAssets()
  const { client, userId } = useShell()
  const api = useAssetsApi()
  const viewer = useAssetViewer()
  const status = useAssets((s) => s.status)
  const loadError = useAssets((s) => s.error)
  const sheets = useAssets((s) => s.sheets)
  const reports = useAssets((s) => s.reports)
  const dashboards = useAssets((s) => s.dashboards)
  const workspaces = useAssets((s) => s.workspaces)
  const folders = useAssets((s) => s.folders)
  const placements = useAssets((s) => s.placements)
  const favorites = useAssets((s) => s.favorites)
  const data = useMemo(
    () => ({ sheets, reports, dashboards, workspaces, folders, placements, favorites }),
    [sheets, reports, dashboards, workspaces, folders, placements, favorites],
  )
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())

  if (viewer.element) return viewer.element

  const act = async (p: Promise<{ ok: true } | { ok: false; error: string }>) => {
    const r = await p
    if (!r.ok) setError(r.error)
  }
  const toggleStar = (kind: FavoriteKind, id: string) => void act(api.getState().toggleFavorite(kind, id))
  const isStar = (kind: FavoriteKind, id: string) => !!favoriteOf(data, kind, id)
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (!next.delete(id)) next.add(id)
      return next
    })

  async function addSheet(spaceId: string, folderId: string | null) {
    setError(null)
    try {
      const id = await insertSheetFromTemplate(client, DEFAULT_TEMPLATE_ID, userId)
      await api.getState().load()
      const r = await api.getState().placeAsset('sheet', id, { spaceId, folderId })
      if (!r.ok) setError(r.error)
      viewer.open('sheet', id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the sheet')
    }
  }

  const goTo = (kind: FavoriteKind, id: string) => {
    if (kind === 'workspace' || kind === 'folder') {
      setQuery('')
      setCollapsed((s) => {
        const next = new Set(s)
        next.delete(id)
        return next
      })
      setTimeout(() => document.getElementById(`${kind}-${id}`)?.scrollIntoView({ block: 'center' }), 0)
    } else viewer.open(kind, id)
  }

  const addMenu = (spaceId: string, folderId: string | null): MenuItem[] => [
    { label: 'New folder', icon: 'folder', onSelect: () => setPending({ kind: 'new-folder', spaceId, parentId: folderId }) },
    { label: 'New sheet', icon: 'sheet', onSelect: () => void addSheet(spaceId, folderId) },
    { label: 'New report', icon: 'report', onSelect: () => setPending({ kind: 'new-report', spaceId, folderId }) },
    { label: 'New dashboard', icon: 'dashboard', onSelect: () => setPending({ kind: 'new-dashboard', spaceId, folderId }) },
  ]

  const assetMenu = (a: AssetRef, inWorkspace: boolean): MenuItem[] => [
    { label: 'Open', icon: 'eye', onSelect: () => viewer.open(a.type, a.id) },
    { label: 'Rename', icon: 'text', onSelect: () => setPending({ kind: 'rename-asset', type: a.type, id: a.id, name: a.name }) },
    { label: inWorkspace ? 'Move…' : 'Move to workspace…', icon: 'move', onSelect: () => setPending({ kind: 'move-asset', type: a.type, id: a.id, name: a.name }) },
    ...(inWorkspace ? [{ label: 'Remove from workspace', icon: 'close' as const, onSelect: () => void act(api.getState().placeAsset(a.type, a.id, null)) }] : []),
  ]

  function Item({ a, inWorkspace, tree = false }: { a: AssetRef; inWorkspace: boolean; tree?: boolean }) {
    return (
      <li className="ws-item">
        <button type="button" className="ws-open" onClick={() => viewer.open(a.type, a.id)}>
          <AssetIcon name={ASSET_ICON[a.type]} size={18} />
          <span className="ws-name">{a.name}</span>
          <span className="chip is-quiet">{ASSET_LABEL[a.type]}</span>
        </button>
        <StarButton name={a.name} on={isStar(a.type, a.id)} onToggle={() => toggleStar(a.type, a.id)} />
        {tree && <span className="ws-spacer" aria-hidden="true" />}
        <ActionMenu label={`Actions for ${a.name}`} items={assetMenu(a, inWorkspace)} />
      </li>
    )
  }

  function FolderNode({ folder, depth }: { folder: Folder; depth: number }) {
    const open = !collapsed.has(folder.id)
    const kids = childFolders(data, folder.spaceId, folder.id)
    const items = itemsAt(data, folder.spaceId, folder.id)
    return (
      <li className="ws-folder" id={`folder-${folder.id}`}>
        <div className="ws-row">
          <button type="button" className="ws-toggle" aria-expanded={open} onClick={() => toggle(folder.id)}>
            <AssetIcon name="chevron" size={14} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
            <AssetIcon name="folder" size={18} />
            <span className="ws-name">{folder.name}</span>
            <span className="chip is-quiet">{kids.length + items.length}</span>
          </button>
          <StarButton name={folder.name} on={isStar('folder', folder.id)} onToggle={() => toggleStar('folder', folder.id)} />
          <ActionMenu label={`Add to ${folder.name}`} items={addMenu(folder.spaceId, folder.id)}>
            <AssetIcon name="plus" size={18} />
          </ActionMenu>
          <ActionMenu
            label={`Actions for folder ${folder.name}`}
            items={[
              { label: 'Rename', icon: 'text', onSelect: () => setPending({ kind: 'rename-folder', id: folder.id, name: folder.name }) },
              { label: 'Move…', icon: 'move', onSelect: () => setPending({ kind: 'move-folder', id: folder.id, name: folder.name }) },
              { label: 'Delete folder', icon: 'trash', danger: true, onSelect: () => setPending({ kind: 'delete-folder', id: folder.id, name: folder.name }) },
            ]}
          />
        </div>
        {open && (
          <ul className="ws-children" style={{ '--depth': depth } as React.CSSProperties}>
            {kids.map((f) => (
              <FolderNode key={f.id} folder={f} depth={depth + 1} />
            ))}
            {items.map((a) => (
              <Item key={`${a.type}${a.id}`} a={a} inWorkspace tree />
            ))}
            {kids.length + items.length === 0 && <li className="ws-empty">This folder is empty.</li>}
          </ul>
        )}
      </li>
    )
  }

  function WorkspaceCard({ ws }: { ws: Workspace }) {
    const open = !collapsed.has(ws.id)
    const kids = childFolders(data, ws.id, null)
    const items = itemsAt(data, ws.id, null)
    const total = placements.filter((p) => p.spaceId === ws.id).length
    return (
      <section className="ws-card card" id={`workspace-${ws.id}`} aria-label={ws.name}>
        <div className="ws-row ws-head">
          <button type="button" className="ws-toggle" aria-expanded={open} onClick={() => toggle(ws.id)}>
            <AssetIcon name="chevron" size={14} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
            <span className="ws-icon">
              <AssetIcon name="home" size={18} />
            </span>
            <h3 className="ws-title">{ws.name}</h3>
            <span className="chip">{total} {total === 1 ? 'item' : 'items'}</span>
          </button>
          <StarButton name={ws.name} on={isStar('workspace', ws.id)} onToggle={() => toggleStar('workspace', ws.id)} />
          <ActionMenu label={`Add to ${ws.name}`} items={addMenu(ws.id, null)} pill>
            <AssetIcon name="plus" size={14} />
            Add
          </ActionMenu>
          <ActionMenu
            label={`Actions for workspace ${ws.name}`}
            items={[
              { label: 'Rename', icon: 'text', onSelect: () => setPending({ kind: 'rename-workspace', id: ws.id, name: ws.name }) },
              { label: 'Delete workspace', icon: 'trash', danger: true, onSelect: () => setPending({ kind: 'delete-workspace', id: ws.id, name: ws.name }) },
            ]}
          />
        </div>
        {open && (
          <ul className="ws-children">
            {kids.map((f) => (
              <FolderNode key={f.id} folder={f} depth={1} />
            ))}
            {items.map((a) => (
              <Item key={`${a.type}${a.id}`} a={a} inWorkspace tree />
            ))}
            {kids.length + items.length === 0 && <li className="ws-empty">Nothing here yet. Use Add to create a folder, sheet, report or dashboard.</li>}
          </ul>
        )}
      </section>
    )
  }

  const q = query.trim()
  const hits: SearchHit[] = q ? searchAssets(data, q) : []
  const unplaced = unplacedAssets(data)
  const favList = favorites.flatMap((f) => favoriteEntry(f, data))
  const recent = readRecent(userId).flatMap((r) => {
    const a = assetRef(data, r.type, r.id)
    return a ? [a] : []
  })

  return (
    <section className="asset-list-page workspaces">
      <PendingDialogs pending={pending} onClose={() => setPending(null)} viewer={viewer} />
      {pending?.kind === 'delete-workspace' && (
        <ConfirmDialog
          title="Delete workspace"
          message={`Delete the workspace "${pending.name}" and its folders? The sheets, reports and dashboards in it are kept, they just leave the workspace.`}
          confirmLabel="Delete"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const id = pending.id
            setPending(null)
            void act(api.getState().deleteWorkspace(id))
          }}
        />
      )}
      {pending?.kind === 'delete-folder' && (
        <ConfirmDialog
          title="Delete folder"
          message={`Delete the folder "${pending.name}" and the folders inside it? The sheets, reports and dashboards in it are kept, they just leave the workspace.`}
          confirmLabel="Delete"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const id = pending.id
            setPending(null)
            void act(api.getState().deleteFolder(id))
          }}
        />
      )}

      <div className="page-intro">
        <h2>Workspaces</h2>
        <p>Keep the sheets, reports and dashboards of a project together in folders. Star what you use most.</p>
      </div>
      <div className="asset-toolbar">
        <div className="search-box">
          <AssetIcon name="search" size={18} />
          <input type="search" aria-label="Search sheets, reports, dashboards and workspaces" placeholder="Search by name" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setPending({ kind: 'new-workspace' })}>
          <AssetIcon name="plus" size={18} />
          New workspace
        </button>
      </div>
      {(error || (loadError && status !== 'ready')) && (
        <p role="alert" className="list-error">
          {error ?? loadError}
          {error && (
            <button type="button" className="btn-icon" aria-label="Dismiss" onClick={() => setError(null)}>
              <AssetIcon name="close" size={16} />
            </button>
          )}
        </p>
      )}

      {status !== 'ready' && !loadError && (
        <div className="sheet-grid" aria-hidden="true">
          {[0, 1].map((i) => (
            <div key={i} className="sheet-card skeleton-card">
              <span className="skeleton skeleton-icon" />
              <span className="skeleton skeleton-line" />
              <span className="skeleton skeleton-line is-short" />
            </div>
          ))}
        </div>
      )}

      {status === 'ready' && q !== '' && (
        <section aria-label="Search results">
          <h3 className="list-heading">
            Results <span className="chip">{hits.length}</span>
          </h3>
          {hits.length === 0 ? (
            <p className="asset-meta" role="status">Nothing matches "{q}".</p>
          ) : (
            <ul className="ws-children is-flat">
              {hits.map((h) => (
                <li key={`${h.kind}${h.id}`} className="ws-item">
                  <button type="button" className="ws-open" onClick={() => goTo(h.kind, h.id)}>
                    <AssetIcon name={h.kind === 'workspace' ? 'home' : h.kind === 'folder' ? 'folder' : ASSET_ICON[h.kind]} size={18} />
                    <span className="ws-name">{h.name}</span>
                    <span className="ws-where">{h.where}</span>
                  </button>
                  <StarButton name={h.name} on={isStar(h.kind, h.id)} onToggle={() => toggleStar(h.kind, h.id)} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {status === 'ready' && q === '' && (
        <>
          {favList.length > 0 && (
            <section aria-label="Favorites" className="ws-strip">
              <h3 className="list-heading">Favorites</h3>
              <ul className="ws-chips">
                {favList.map((f) => (
                  <li key={f.id}>
                    <button type="button" className="ws-chip" onClick={() => goTo(f.kind, f.targetId)}>
                      <AssetIcon name="star" size={14} filled />
                      <AssetIcon name={f.kind === 'workspace' ? 'home' : f.kind === 'folder' ? 'folder' : ASSET_ICON[f.kind]} size={16} />
                      <span>{f.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {recent.length > 0 && (
            <section aria-label="Recent" className="ws-strip">
              <h3 className="list-heading">Recent</h3>
              <ul className="ws-chips">
                {recent.slice(0, 8).map((a) => (
                  <li key={`${a.type}${a.id}`}>
                    <button type="button" className="ws-chip" onClick={() => viewer.open(a.type, a.id)}>
                      <AssetIcon name="clock" size={14} />
                      <AssetIcon name={ASSET_ICON[a.type]} size={16} />
                      <span>{a.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <h3 className="list-heading">
            Workspaces <span className="chip">{workspaces.length}</span>
          </h3>
          {workspaces.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">
                <AssetIcon name="folder" size={28} />
              </span>
              <p className="empty-title">No workspaces yet</p>
              <p className="empty-text">Create a workspace for a project or a team, then add folders and move your sheets, reports and dashboards into it.</p>
            </div>
          ) : (
            <div className="ws-list">
              {[...workspaces].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map((ws) => (
                <WorkspaceCard key={ws.id} ws={ws} />
              ))}
            </div>
          )}

          <section aria-label="Not in a workspace" className="ws-unplaced">
            <h3 className="list-heading">
              Not in a workspace <span className="chip">{unplaced.length}</span>
            </h3>
            {unplaced.length === 0 ? (
              <p className="asset-meta">Everything you own is in a workspace.</p>
            ) : (
              <ul className="ws-children is-flat">
                {unplaced.map((a) => (
                  <Item key={`${a.type}${a.id}`} a={a} inWorkspace={false} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </section>
  )
}

function StarButton({ name, on, onToggle }: { name: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`btn-icon${on ? ' is-starred' : ''}`}
      aria-pressed={on}
      aria-label={on ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
      title={on ? 'Remove from favorites' : 'Add to favorites'}
      onClick={onToggle}
    >
      <AssetIcon name="star" size={18} filled={on} />
    </button>
  )
}

/** A favourite with its current name; favourites whose target is gone are dropped. */
function favoriteEntry(f: Favorite, data: Parameters<typeof assetRef>[0] & { workspaces: Workspace[]; folders: Folder[] }) {
  const name =
    f.kind === 'workspace'
      ? data.workspaces.find((w) => w.id === f.targetId)?.name
      : f.kind === 'folder'
        ? data.folders.find((x) => x.id === f.targetId)?.name
        : assetRef(data, f.kind, f.targetId)?.name
  return name ? [{ ...f, name }] : []
}

/** The prompts and the move dialog for the pending action (the delete confirmations are inline in the page). */
function PendingDialogs({ pending, onClose, viewer }: { pending: Pending | null; onClose: () => void; viewer: ReturnType<typeof useAssetViewer> }) {
  const api = useAssetsApi()
  if (!pending) return null
  const store = api.getState()
  switch (pending.kind) {
    case 'new-workspace':
      return <PromptDialog title="New workspace" label="Workspace name" confirmLabel="Create" onClose={onClose} onSubmit={async (n) => { const r = await store.createWorkspace(n); return r.ok ? null : r.error }} />
    case 'new-folder':
      return <PromptDialog title="New folder" label="Folder name" confirmLabel="Create" onClose={onClose} onSubmit={async (n) => { const r = await store.createFolder(pending.spaceId, pending.parentId, n); return r.ok ? null : r.error }} />
    case 'new-report':
      return (
        <PromptDialog
          title="New report"
          label="Report name"
          confirmLabel="Create and set up"
          onClose={onClose}
          onSubmit={async (n) => {
            const r = await store.createReport(n, undefined, { spaceId: pending.spaceId, folderId: pending.folderId })
            if (!r.ok) return r.error
            viewer.open('report', r.value.id, true)
            return null
          }}
        />
      )
    case 'new-dashboard':
      return (
        <PromptDialog
          title="New dashboard"
          label="Dashboard name"
          confirmLabel="Create"
          onClose={onClose}
          onSubmit={async (n) => {
            const r = await store.createDashboard(n, undefined, { spaceId: pending.spaceId, folderId: pending.folderId })
            if (!r.ok) return r.error
            viewer.open('dashboard', r.value.id, true)
            return null
          }}
        />
      )
    case 'rename-workspace':
      return <PromptDialog title="Rename workspace" label="Workspace name" initial={pending.name} confirmLabel="Rename" onClose={onClose} onSubmit={async (n) => { const r = await store.renameWorkspace(pending.id, n); return r.ok ? null : r.error }} />
    case 'rename-folder':
      return <PromptDialog title="Rename folder" label="Folder name" initial={pending.name} confirmLabel="Rename" onClose={onClose} onSubmit={async (n) => { const r = await store.renameFolder(pending.id, n); return r.ok ? null : r.error }} />
    case 'rename-asset':
      return (
        <PromptDialog
          title={`Rename ${ASSET_LABEL[pending.type].toLowerCase()}`}
          label={`${ASSET_LABEL[pending.type]} name`}
          initial={pending.name}
          confirmLabel="Rename"
          onClose={onClose}
          onSubmit={async (n) => {
            const v = validateAssetName(n, `${ASSET_LABEL[pending.type].toLowerCase()} name`)
            if (!v.ok) return v.error
            const r =
              pending.type === 'sheet'
                ? await store.renameSheet(pending.id, v.name)
                : pending.type === 'report'
                  ? await store.saveReport(pending.id, { name: v.name })
                  : await store.renameDashboard(pending.id, v.name)
            return r.ok ? null : r.error
          }}
        />
      )
    case 'move-asset':
      return <MoveDialog asset={{ type: pending.type, id: pending.id, name: pending.name }} onClose={onClose} />
    case 'move-folder':
      return <MoveDialog folder={{ id: pending.id, name: pending.name }} onClose={onClose} />
    default:
      return null
  }
}
