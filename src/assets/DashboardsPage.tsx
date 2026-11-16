import { useState } from 'react'
import { ConfirmDialog } from '../views/ConfirmDialog'
import { assetLocation } from './assetModel'
import { AssetCard } from './AssetCard'
import { AssetIcon } from './AssetIcon'
import { validateAssetName } from './assetsStore'
import { useAssetViewer } from './AssetViewer'
import { MoveDialog } from './MoveDialog'
import { PromptDialog } from './PromptDialog'
import type { DashboardMeta } from './types'
import { useAssets, useAssetsApi, useLoadAssets } from './useAssets'

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/** Dashboards: pages of metrics, charts, Gantt grids, text and shortcuts over your sheets and reports. */
export function DashboardsPage() {
  useLoadAssets()
  const api = useAssetsApi()
  const viewer = useAssetViewer()
  const status = useAssets((s) => s.status)
  const loadError = useAssets((s) => s.error)
  const dashboards = useAssets((s) => s.dashboards)
  const favorites = useAssets((s) => s.favorites)
  const placements = useAssets((s) => s.placements)
  const workspaces = useAssets((s) => s.workspaces)
  const folders = useAssets((s) => s.folders)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<DashboardMeta | null>(null)
  const [deleting, setDeleting] = useState<DashboardMeta | null>(null)
  const [moving, setMoving] = useState<DashboardMeta | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (viewer.element) return viewer.element

  const sorted = [...dashboards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return (
    <section className="asset-list-page">
      {creating && (
        <PromptDialog
          title="New dashboard"
          label="Dashboard name"
          confirmLabel="Create"
          description="A dashboard is a page of widgets: numbers, charts, timelines, text and shortcuts."
          onClose={() => setCreating(false)}
          onSubmit={async (name) => {
            const res = await api.getState().createDashboard(name)
            if (!res.ok) return res.error
            viewer.open('dashboard', res.value.id, true)
            return null
          }}
        />
      )}
      {renaming && (
        <PromptDialog
          title="Rename dashboard"
          label="Dashboard name"
          initial={renaming.name}
          confirmLabel="Rename"
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            const v = validateAssetName(name, 'dashboard name')
            if (!v.ok) return v.error
            const r = await api.getState().renameDashboard(renaming.id, v.name)
            return r.ok ? null : r.error
          }}
        />
      )}
      {moving && <MoveDialog asset={{ type: 'dashboard', id: moving.id, name: moving.name }} onClose={() => setMoving(null)} />}
      {deleting && (
        <ConfirmDialog
          title="Delete dashboard"
          message={`Delete "${deleting.name}"? The sheets and reports it shows are not touched. This cannot be undone.`}
          confirmLabel="Delete"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const target = deleting
            setDeleting(null)
            const r = await api.getState().deleteDashboard(target.id)
            if (!r.ok) setError(`Could not delete "${target.name}": ${r.error}`)
          }}
        />
      )}

      <div className="page-intro">
        <h2>Dashboards</h2>
        <p>Put the numbers that matter on one page: metrics, charts, Gantt grids, notes and shortcuts, live from your sheets and reports.</p>
      </div>
      <div className="asset-toolbar">
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          <AssetIcon name="plus" size={18} />
          New dashboard
        </button>
      </div>
      {(error || (loadError && status !== 'ready')) && (
        <p role="alert" className="list-error">
          {error ?? loadError}
        </p>
      )}
      {status !== 'ready' && !loadError && (
        <div className="sheet-grid" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="sheet-card skeleton-card">
              <span className="skeleton skeleton-icon" />
              <span className="skeleton skeleton-line" />
              <span className="skeleton skeleton-line is-short" />
            </div>
          ))}
        </div>
      )}
      {status === 'ready' && sorted.length === 0 && (
        <div className="empty-state">
          <span className="empty-icon">
            <AssetIcon name="dashboard" size={28} />
          </span>
          <p className="empty-title">No dashboards yet</p>
          <p className="empty-text">Create one for a project: a progress number, a chart of tasks by status, a Gantt of the next milestones.</p>
        </div>
      )}
      {sorted.length > 0 && (
        <ul className="asset-grid">
          {sorted.map((d) => {
            const place = assetLocation({ placements, workspaces, folders }, 'dashboard', d.id)
            const n = d.layout.widgets.length
            return (
              <AssetCard
                key={d.id}
                type="dashboard"
                name={d.name}
                meta={`${n} ${n === 1 ? 'widget' : 'widgets'} · updated ${formatDate(d.updatedAt)}${place ? ` · ${place}` : ''}`}
                favorite={favorites.some((f) => f.kind === 'dashboard' && f.targetId === d.id)}
                onOpen={() => viewer.open('dashboard', d.id)}
                onToggleFavorite={() => void api.getState().toggleFavorite('dashboard', d.id)}
                menu={[
                  { label: 'Open', icon: 'eye', onSelect: () => viewer.open('dashboard', d.id) },
                  { label: 'Edit dashboard', icon: 'pencil', onSelect: () => viewer.open('dashboard', d.id, true) },
                  { label: 'Rename', icon: 'text', onSelect: () => setRenaming(d) },
                  { label: 'Move to workspace…', icon: 'move', onSelect: () => setMoving(d) },
                  { label: 'Delete', icon: 'trash', danger: true, onSelect: () => setDeleting(d) },
                ]}
              />
            )
          })}
        </ul>
      )}
    </section>
  )
}
