import { useState } from 'react'
import { useShell } from '../shell/ShellContext'
import { ConfirmDialog } from '../views/ConfirmDialog'
import { InlineRename } from '../views/InlineRename'
import { ActionMenu } from './ActionMenu'
import { AssetIcon, WIDGET_ICON, WIDGET_LABEL } from './AssetIcon'
import { DashboardCanvas } from './DashboardCanvas'
import { refsOf, useSources } from './dashboardData'
import { newWidget, WIDGET_TYPES } from './definition'
import { compact, nextFreeSlot } from './grid'
import { useSheetHub } from './sheetHub'
import { MAX_WIDGETS, type AssetType, type DashboardLayout, type Widget, type WidgetType } from './types'
import { useAssets, useAssetsApi } from './useAssets'
import { validateAssetName } from './assetsStore'
import { WidgetConfigDialog } from './WidgetConfigDialog'

interface Props {
  id: string
  startInEdit?: boolean
  onBack: () => void
  backLabel?: string
  /** Opens a sheet, report or dashboard (a shortcut widget). */
  onOpen: (type: AssetType, id: string) => void
}

const NEEDS_SETUP: WidgetType[] = ['metric', 'chart', 'gantt', 'timeline', 'shortcut', 'image', 'text', 'title']

/** One dashboard: the live view, and edit mode (add, arrange, configure and delete widgets; saved as you go). */
export function DashboardScreen({ id, startInEdit = false, onBack, onOpen, backLabel = 'Dashboards' }: Props) {
  const { client } = useShell()
  const api = useAssetsApi()
  const hub = useSheetHub(client)
  const dashboard = useAssets((s) => s.dashboards.find((d) => d.id === id))
  const status = useAssets((s) => s.status)
  const favorites = useAssets((s) => s.favorites)
  const saveState = useAssets((s) => s.dashboardSave)
  const [editing, setEditing] = useState(startInEdit)
  const [configuring, setConfiguring] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Widget | null>(null)
  const [renaming, setRenaming] = useState(false)
  const layout = dashboard?.layout ?? { widgets: [] }
  const sourceOf = useSources(hub, refsOf(layout))

  if (!dashboard) {
    return (
      <section className="asset-screen">
        <p className="asset-meta" role="status">
          {status === 'ready' ? 'This dashboard no longer exists.' : 'Loading the dashboard…'}
        </p>
        <button type="button" className="btn" onClick={onBack}>
          Back
        </button>
      </section>
    )
  }

  const star = favorites.find((f) => f.kind === 'dashboard' && f.targetId === id)
  const commit = (next: DashboardLayout) => api.getState().setDashboardLayout(id, next)

  function add(type: WidgetType) {
    if (layout.widgets.length >= MAX_WIDGETS) return
    const size = newWidget(type, '')
    const slot = nextFreeSlot(layout.widgets, size.w, size.h)
    const widget = newWidget(type, crypto.randomUUID(), slot.x, slot.y)
    commit({ widgets: [...layout.widgets, widget] })
    if (NEEDS_SETUP.includes(type)) setConfiguring(widget.id)
  }

  const configured = layout.widgets.find((w) => w.id === configuring)

  return (
    <section className="asset-screen dashboard-screen">
      {removing && (
        <ConfirmDialog
          title="Delete widget"
          message={`Delete "${removing.title || WIDGET_LABEL[removing.type]}" from this dashboard?`}
          confirmLabel="Delete"
          onConfirm={() => {
            commit({ widgets: layout.widgets.filter((w) => w.id !== removing.id) })
            setRemoving(null)
          }}
          onCancel={() => setRemoving(null)}
        />
      )}
      {configured && (
        <WidgetConfigDialog
          widget={configured}
          hub={hub}
          onCancel={() => setConfiguring(null)}
          onApply={(w) => {
            commit({ widgets: layout.widgets.map((x) => (x.id === w.id ? w : x)) })
            setConfiguring(null)
          }}
        />
      )}
      <header className="asset-head">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <button type="button" className="crumb-link" onClick={onBack}>
            <AssetIcon name="back" size={16} />
            {backLabel}
          </button>
          <AssetIcon name="chevron" size={14} className="crumb-sep" />
          {renaming ? (
            <InlineRename
              initial={dashboard.name}
              label="Dashboard name"
              validate={(raw) => validateAssetName(raw, 'dashboard name')}
              onCancel={() => setRenaming(false)}
              onSave={async (name) => {
                const r = await api.getState().renameDashboard(id, name)
                if (r.ok) setRenaming(false)
                return r.ok ? null : r.error
              }}
            />
          ) : (
            <>
              <h2 className="asset-title">{dashboard.name}</h2>
              <button type="button" className="btn-icon" aria-label={`Rename ${dashboard.name}`} title="Rename" onClick={() => setRenaming(true)}>
                <AssetIcon name="pencil" size={16} />
              </button>
            </>
          )}
        </nav>
        <span className="spacer" />
        {saveState === 'failed' ? (
          <span className="save-badge is-failed" role="alert">
            Changes did not save
            <button type="button" className="btn btn-sm" onClick={() => void api.getState().flush()}>
              Retry
            </button>
          </span>
        ) : editing ? (
          <span className="save-badge" role="status">
            {saveState === 'saving' ? 'Saving…' : 'Saved'}
          </span>
        ) : null}
        <button
          type="button"
          className="btn-icon"
          aria-pressed={!!star}
          aria-label={star ? `Remove ${dashboard.name} from favorites` : `Add ${dashboard.name} to favorites`}
          title={star ? 'Remove from favorites' : 'Add to favorites'}
          onClick={() => void api.getState().toggleFavorite('dashboard', id)}
        >
          <AssetIcon name="star" filled={!!star} />
        </button>
        {editing && (
          <>
            <ActionMenu
              pill
              label="Add widget"
              items={WIDGET_TYPES.map((t) => ({ label: WIDGET_LABEL[t], icon: WIDGET_ICON[t], onSelect: () => add(t), disabled: layout.widgets.length >= MAX_WIDGETS }))}
            >
              <AssetIcon name="plus" size={16} />
              Add widget
            </ActionMenu>
            <button type="button" className="btn btn-sm" onClick={() => commit({ widgets: compact(layout.widgets) })} disabled={layout.widgets.length < 2}>
              Tidy up
            </button>
          </>
        )}
        <button
          type="button"
          className={`btn btn-sm${editing ? ' btn-primary' : ''}`}
          onClick={() => {
            setEditing((e) => !e)
            if (editing) void api.getState().flush()
          }}
        >
          <AssetIcon name={editing ? 'check' : 'pencil'} size={16} />
          {editing ? 'Done' : 'Edit dashboard'}
        </button>
      </header>

      {layout.widgets.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">
            <AssetIcon name="dashboard" size={28} />
          </span>
          <p className="empty-title">This dashboard is empty</p>
          <p className="empty-text">Add a metric, a chart, a Gantt grid, text or shortcuts, then arrange them on the page.</p>
          {!editing && (
            <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}>
              Add widgets
            </button>
          )}
        </div>
      ) : null}
      <DashboardCanvas
        layout={layout}
        editing={editing}
        sourceOf={sourceOf}
        onChange={commit}
        onConfigure={setConfiguring}
        onDelete={(wid) => setRemoving(layout.widgets.find((w) => w.id === wid) ?? null)}
        onOpen={onOpen}
      />
      {editing && layout.widgets.length > 0 && <p className="builder-hint">Drag a widget by its handle and resize it from its corner. With the keyboard, focus the handle and use the arrow keys (Shift to resize).</p>}
    </section>
  )
}
