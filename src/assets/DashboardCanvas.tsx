import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { AssetIcon, WIDGET_ICON, WIDGET_LABEL } from './AssetIcon'
import type { DataSource } from './dashboardData'
import { nudge, placeWidget, stackOrder, type MoveDirection } from './grid'
import { GRID_COLUMNS, type AssetType, type DashboardLayout, type SourceRef, type Widget } from './types'
import { WidgetView } from './WidgetView'

export const ROW_HEIGHT = 72
export const GAP = 16

interface Props {
  layout: DashboardLayout
  editing: boolean
  sourceOf: (ref: SourceRef | null) => DataSource
  onChange: (layout: DashboardLayout) => void
  onConfigure: (id: string) => void
  onDelete: (id: string) => void
  onOpen: (type: AssetType, id: string) => void
}

type Drag = { id: string; mode: 'move' | 'resize'; startX: number; startY: number; widgets: Widget[] }

const ARROWS: Record<string, MoveDirection> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

/**
 * The dashboard grid. On a wide screen the widgets sit at their (x, y) on 12 columns; in edit mode a
 * widget drags by its handle and resizes by its corner on a snap grid (others are pushed down). The
 * handle is a button too: arrow keys move, Shift + arrows resize. On a phone the widgets stack in
 * reading order and the up / down buttons reorder them.
 */
export function DashboardCanvas({ layout, editing, sourceOf, onChange, onConfigure, onDelete, onOpen }: Props) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const widgets = stackOrder(drag?.widgets ?? layout.widgets)

  function begin(e: PointerEvent<HTMLElement>, w: Widget, mode: Drag['mode']) {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ id: w.id, mode, startX: e.clientX, startY: e.clientY, widgets: layout.widgets })
  }

  function move(e: PointerEvent<HTMLElement>) {
    if (!drag || !gridRef.current) return
    const w = layout.widgets.find((x) => x.id === drag.id)
    if (!w) return
    const rect = gridRef.current.getBoundingClientRect()
    const col = (rect.width - GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS
    const dx = Math.round((e.clientX - drag.startX) / (col + GAP))
    const dy = Math.round((e.clientY - drag.startY) / (ROW_HEIGHT + GAP))
    const next = drag.mode === 'move' ? placeWidget(layout.widgets, w.id, { x: w.x + dx, y: w.y + dy }) : placeWidget(layout.widgets, w.id, { w: w.w + dx, h: w.h + dy })
    setDrag((d) => (d ? { ...d, widgets: next } : d))
  }

  function end() {
    if (drag) {
      const changed = JSON.stringify(drag.widgets) !== JSON.stringify(layout.widgets)
      if (changed) onChange({ widgets: drag.widgets })
    }
    setDrag(null)
  }

  function onHandleKey(e: KeyboardEvent<HTMLElement>, w: Widget) {
    const dir = ARROWS[e.key]
    if (!dir) return
    e.preventDefault()
    onChange({ widgets: nudge(layout.widgets, w.id, dir, e.shiftKey) })
  }

  return (
    <div ref={gridRef} className={`dash-grid${editing ? ' is-editing' : ''}${drag ? ' is-dragging' : ''}`} role="list" aria-label="Dashboard widgets">
      {widgets.map((w) => {
        const style = {
          '--gc': `${w.x + 1} / span ${w.w}`,
          '--gr': `${w.y + 1} / span ${w.h}`,
          '--h': w.h,
        } as CSSProperties
        const label = w.title || WIDGET_LABEL[w.type]
        return (
          <article
            key={w.id}
            role="listitem"
            aria-label={label}
            className={`dash-widget card is-${w.type}${drag?.id === w.id ? ' is-active' : ''}`}
            style={style}
          >
            {(editing || (w.title && w.type !== 'title')) && (
              <header className="dash-widget-head">
                {editing && (
                  <button
                    type="button"
                    className="btn-icon dash-grip"
                    aria-label={`Move ${label}. Arrow keys move it, Shift and arrow keys resize it.`}
                    title="Drag to move"
                    onPointerDown={(e) => begin(e, w, 'move')}
                    onPointerMove={move}
                    onPointerUp={end}
                    onPointerCancel={() => setDrag(null)}
                    onKeyDown={(e) => onHandleKey(e, w)}
                  >
                    <AssetIcon name="grip" size={18} />
                  </button>
                )}
                {w.type !== 'title' && (
                  <h3 className="dash-widget-title">
                    {!w.title && editing && <AssetIcon name={WIDGET_ICON[w.type]} size={15} />}
                    {w.title || (editing ? WIDGET_LABEL[w.type] : '')}
                  </h3>
                )}
                {editing && (
                  <span className="dash-tools">
                    <button type="button" className="btn-icon dash-reorder" aria-label={`Move ${label} up`} onClick={() => onChange({ widgets: nudge(layout.widgets, w.id, 'up') })}>
                      <AssetIcon name="up" size={16} />
                    </button>
                    <button type="button" className="btn-icon dash-reorder" aria-label={`Move ${label} down`} onClick={() => onChange({ widgets: nudge(layout.widgets, w.id, 'down') })}>
                      <AssetIcon name="down" size={16} />
                    </button>
                    <button type="button" className="btn-icon" aria-label={`Settings for ${label}`} title="Settings" onClick={() => onConfigure(w.id)}>
                      <AssetIcon name="settings" size={17} />
                    </button>
                    <button type="button" className="btn-icon is-danger" aria-label={`Delete ${label}`} title="Delete" onClick={() => onDelete(w.id)}>
                      <AssetIcon name="trash" size={17} />
                    </button>
                  </span>
                )}
              </header>
            )}
            <div className="dash-widget-body">
              <WidgetView widget={w} source={'source' in w.config ? sourceOf(w.config.source) : sourceOf(null)} onOpen={onOpen} />
            </div>
            {editing && (
              <span
                className="dash-resize"
                role="presentation"
                onPointerDown={(e) => begin(e, w, 'resize')}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={() => setDrag(null)}
              />
            )}
          </article>
        )
      })}
    </div>
  )
}
