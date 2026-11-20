import { useState } from 'react'
import { ConfirmDialog } from '../views/ConfirmDialog'
import { assetLocation } from './assetModel'
import { AssetCard } from './AssetCard'
import { AssetIcon } from './AssetIcon'
import { validateAssetName } from './assetsStore'
import { useAssetViewer } from './AssetViewer'
import { MoveDialog } from './MoveDialog'
import { PromptDialog } from './PromptDialog'
import type { ReportMeta } from './types'
import { useAssets, useAssetsApi, useLoadAssets } from './useAssets'

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/** Reports: rows pulled live from many sheets into one filterable, groupable, editable list. */
export function ReportsPage() {
  useLoadAssets()
  const api = useAssetsApi()
  const viewer = useAssetViewer()
  const status = useAssets((s) => s.status)
  const loadError = useAssets((s) => s.error)
  const reports = useAssets((s) => s.reports)
  const favorites = useAssets((s) => s.favorites)
  const placements = useAssets((s) => s.placements)
  const workspaces = useAssets((s) => s.workspaces)
  const folders = useAssets((s) => s.folders)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<ReportMeta | null>(null)
  const [deleting, setDeleting] = useState<ReportMeta | null>(null)
  const [moving, setMoving] = useState<ReportMeta | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (viewer.element) return viewer.element

  const sorted = [...reports].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return (
    <section className="asset-list-page">
      {creating && (
        <PromptDialog
          title="New report"
          label="Report name"
          confirmLabel="Create and set up"
          description="A report pulls rows from the sheets you choose into one list."
          onClose={() => setCreating(false)}
          onSubmit={async (name) => {
            const res = await api.getState().createReport(name)
            if (!res.ok) return res.error
            viewer.open('report', res.value.id, true)
            return null
          }}
        />
      )}
      {renaming && (
        <PromptDialog
          title="Rename report"
          label="Report name"
          initial={renaming.name}
          confirmLabel="Rename"
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            const v = validateAssetName(name, 'report name')
            if (!v.ok) return v.error
            const r = await api.getState().saveReport(renaming.id, { name: v.name })
            return r.ok ? null : r.error
          }}
        />
      )}
      {moving && <MoveDialog asset={{ type: 'report', id: moving.id, name: moving.name }} onClose={() => setMoving(null)} />}
      {deleting && (
        <ConfirmDialog
          title="Delete report"
          message={`Delete "${deleting.name}"? The sheets it reads from are not touched. This cannot be undone.`}
          confirmLabel="Delete"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const target = deleting
            setDeleting(null)
            const r = await api.getState().deleteReport(target.id)
            if (!r.ok) setError(`Could not delete "${target.name}": ${r.error}`)
          }}
        />
      )}

      <div className="page-intro">
        <h2>Reports</h2>
        <p>Pull rows from many sheets into one live list. Filter, sort, group and total them, and edit a value right in the report.</p>
      </div>
      <div className="asset-toolbar">
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          <AssetIcon name="plus" size={18} />
          New report
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
            <AssetIcon name="report" size={28} />
          </span>
          <p className="empty-title">No reports yet</p>
          <p className="empty-text">Create a report to see the open items of several sheets in one place, for example every overdue task across your projects.</p>
        </div>
      )}
      {sorted.length > 0 && (
        <ul className="asset-grid">
          {sorted.map((r) => {
            const place = assetLocation({ placements, workspaces, folders }, 'report', r.id)
            const n = r.definition.sources.length
            return (
              <AssetCard
                key={r.id}
                type="report"
                name={r.name}
                meta={`${n} ${n === 1 ? 'sheet' : 'sheets'} · ${r.definition.columns.length} columns · updated ${formatDate(r.updatedAt)}${place ? ` · ${place}` : ''}`}
                favorite={favorites.some((f) => f.kind === 'report' && f.targetId === r.id)}
                onOpen={() => viewer.open('report', r.id)}
                onToggleFavorite={() => void api.getState().toggleFavorite('report', r.id)}
                menu={[
                  { label: 'Open', icon: 'eye', onSelect: () => viewer.open('report', r.id) },
                  { label: 'Edit report', icon: 'pencil', onSelect: () => viewer.open('report', r.id, true) },
                  { label: 'Rename', icon: 'text', onSelect: () => setRenaming(r) },
                  { label: 'Move to workspace…', icon: 'move', onSelect: () => setMoving(r) },
                  { label: 'Delete', icon: 'trash', danger: true, onSelect: () => setDeleting(r) },
                ]}
              />
            )
          })}
        </ul>
      )}
    </section>
  )
}

