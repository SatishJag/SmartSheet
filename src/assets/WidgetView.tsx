import { useMemo } from 'react'
import { AssetIcon, ASSET_ICON, WIDGET_LABEL } from './AssetIcon'
import { Chart } from './Chart'
import type { DataSource } from './dashboardData'
import { RichText } from './RichText'
import { TimelineChart } from './TimelineChart'
import type { AssetType, Widget } from './types'
import { useAssets } from './useAssets'
import { todayIso } from './values'
import { chartData, metricValue, timeItems } from './widgetData'

interface Props {
  widget: Widget
  source: DataSource
  /** Opens a sheet, report or dashboard (shortcuts). */
  onOpen: (type: AssetType, id: string) => void
}

const Hint = ({ children }: { children: string }) => <p className="widget-hint">{children}</p>

/** What a widget shows. The card around it (title, edit controls, position) is the canvas's job. */
export function WidgetView({ widget, source, onOpen }: Props) {
  const today = todayIso()
  const w = widget

  if (w.type === 'title') {
    return <h2 className={`widget-title-text is-${w.config.size}`}>{w.config.text || <span className="widget-hint">Title</span>}</h2>
  }
  if (w.type === 'text') return w.config.text.trim() ? <RichText text={w.config.text} /> : <Hint>Add some text.</Hint>
  if (w.type === 'image') {
    if (!w.config.url) return <Hint>Add an image address (https).</Hint>
    const img = <img src={w.config.url} alt={w.config.alt} className="widget-image" loading="lazy" referrerPolicy="no-referrer" />
    return w.config.link ? (
      <a href={w.config.link} target="_blank" rel="noopener noreferrer" className="widget-image-link">
        {img}
      </a>
    ) : (
      img
    )
  }
  if (w.type === 'shortcut') return <ShortcutList widget={w} onOpen={onOpen} />

  // The rest read data.
  const config = w.config
  if (!config.source) return <Hint>Choose a sheet or report for this widget.</Hint>
  if (source.loading) return <p className="widget-hint" role="status">Loading…</p>
  if (source.error || !source.table) return <p className="widget-hint is-error" role="alert">{source.error ?? 'No data.'}</p>
  const table = source.table

  if (w.type === 'metric') return <Metric widget={w} table={table} today={today} />
  if (w.type === 'chart') {
    const c = w.config
    if (!c.category) return <Hint>Choose what to chart.</Hint>
    return <ChartBody widget={w} table={table} today={today} />
  }
  const data = timeItems(table, w.config, today)
  if (!w.config.start) return <Hint>Choose the start date column.</Hint>
  if (data.items.length === 0) return <Hint>No dated rows to show.</Hint>
  return (
    <div className="widget-scroll">
      <TimelineChart data={data} mode={w.type} label={w.title || WIDGET_LABEL[w.type]} today={today} />
      {data.skipped > 0 && <p className="widget-note">{data.skipped} rows without a start date are not shown.</p>}
    </div>
  )
}

function Metric({ widget, table, today }: { widget: Extract<Widget, { type: 'metric' }>; table: NonNullable<DataSource['table']>; today: string }) {
  const r = useMemo(() => metricValue(table, widget.config, today), [table, widget.config, today])
  return (
    <div className="widget-metric">
      <output className="widget-metric-value" aria-label={`${widget.title || 'Metric'}: ${r.display}`}>
        {r.display}
      </output>
      {r.note && <p className="widget-note">{r.note}</p>}
    </div>
  )
}

function ChartBody({ widget, table, today }: { widget: Extract<Widget, { type: 'chart' }>; table: NonNullable<DataSource['table']>; today: string }) {
  const data = useMemo(() => chartData(table, widget.config, today), [table, widget.config, today])
  if (data.categories.length === 0) return <Hint>No data to chart.</Hint>
  return (
    <>
      <Chart data={data} kind={widget.config.kind} label={widget.title || 'Chart'} />
      {data.note && <p className="widget-note">{data.note}</p>}
    </>
  )
}

function ShortcutList({ widget, onOpen }: { widget: Extract<Widget, { type: 'shortcut' }>; onOpen: Props['onOpen'] }) {
  const sheets = useAssets((s) => s.sheets)
  const reports = useAssets((s) => s.reports)
  const dashboards = useAssets((s) => s.dashboards)
  const links = widget.config.links
  if (links.length === 0) return <Hint>Add links to sheets, reports, dashboards or web pages.</Hint>
  const nameOf = (kind: AssetType, id: string) => (kind === 'sheet' ? sheets : kind === 'report' ? reports : dashboards).find((x) => x.id === id)?.name
  return (
    <ul className="shortcut-list">
      {links.map((l, i) => {
        if (l.kind === 'url') {
          return (
            <li key={i}>
              <a href={l.target} target="_blank" rel="noopener noreferrer" className="shortcut">
                <AssetIcon name="link" size={18} />
                <span>{l.label || l.target}</span>
              </a>
            </li>
          )
        }
        const name = nameOf(l.kind, l.target)
        return (
          <li key={i}>
            <button type="button" className="shortcut" disabled={!name} onClick={() => onOpen(l.kind as AssetType, l.target)}>
              <AssetIcon name={ASSET_ICON[l.kind as AssetType]} size={18} />
              <span>{l.label || name || 'Missing item'}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

