import { useId, useMemo, useState, type ReactNode } from 'react'
import { Dialog } from './Dialog'
import { FilterEditor, type FilterColumn } from './FilterEditor'
import { GRID_COLUMNS, type MetricConfig, type ShortcutLink, type SourceRef, type Widget } from './types'
import { WIDGET_LABEL } from './AssetIcon'
import { useSources } from './dashboardData'
import { safeUrl } from './definition'
import { clampRect, MAX_HEIGHT } from './grid'
import type { SheetHub } from './sheetHub'
import { useAssets } from './useAssets'
import { formatValue } from './values'
import type { Table } from './widgetData'

interface Props {
  widget: Widget
  hub: SheetHub
  onApply: (widget: Widget) => void
  onCancel: () => void
}

type AnyConfig = Record<string, unknown>

const refKey = (r: SourceRef | null) => (r ? `${r.type}:${r.id}` : '')
const parseRef = (v: string): SourceRef | null => {
  const [type, ...rest] = v.split(':')
  return (type === 'sheet' || type === 'report') && rest.length ? { type, id: rest.join(':') } : null
}

function Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: string }) {
  const id = useId()
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <p className="builder-hint">{hint}</p>}
    </div>
  )
}

function ColumnSelect({ id, columns, value, onChange, empty }: { id: string; columns: FilterColumn[]; value: string | null; onChange: (v: string | null) => void; empty?: string }) {
  return (
    <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{empty ?? 'Choose a column…'}</option>
      {value && !columns.some((c) => c.key === value) && <option value={value}>(missing column)</option>}
      {columns.map((c) => (
        <option key={c.key} value={c.key}>
          {c.title}
        </option>
      ))}
    </select>
  )
}

/** Edits one widget: its title, the data it reads, how it draws, and where it sits on the grid. */
export function WidgetConfigDialog({ widget, hub, onApply, onCancel }: Props) {
  const [draft, setDraft] = useState<Widget>(widget)
  const sheets = useAssets((s) => s.sheets)
  const reports = useAssets((s) => s.reports)
  const dashboards = useAssets((s) => s.dashboards)

  const config = draft.config as AnyConfig
  const needsData = draft.type === 'metric' || draft.type === 'chart' || draft.type === 'gantt' || draft.type === 'timeline'
  const source = needsData ? ((config.source as SourceRef | null) ?? null) : null
  const sourceOf = useSources(hub, source ? [source] : [])
  const data = sourceOf(source)
  const table: Table | null = data.table
  const columns: FilterColumn[] = useMemo(() => table?.columns ?? [], [table])
  const dateColumns = columns.filter((c) => c.type === 'DATE')

  const setConfig = (patch: AnyConfig) => setDraft((d) => ({ ...d, config: { ...(d.config as AnyConfig), ...patch } }) as Widget)
  const setSource = (v: string) => {
    const ref = parseRef(v)
    // Columns belong to a source: changing it clears what pointed into the old one.
    const reset: AnyConfig = { column: null, category: null, value: null, stackBy: null, label: null, start: null, end: null, rowId: null, filter: { match: 'all', conditions: [] } }
    setConfig({ source: ref, ...Object.fromEntries(Object.entries(reset).filter(([k]) => k in config)) })
  }
  const setRect = (patch: Partial<{ x: number; y: number; w: number; h: number }>) =>
    setDraft((d) => ({ ...d, ...clampRect({ x: d.x, y: d.y, w: d.w, h: d.h, ...patch }) }))

  const sourcePicker = needsData && (
    <Field label="Data from">
      {(id) => (
        <select id={id} value={refKey(source)} onChange={(e) => setSource(e.target.value)}>
          <option value="">Choose a sheet or report…</option>
          <optgroup label="Sheets">
            {sheets.map((s) => (
              <option key={s.id} value={`sheet:${s.id}`}>
                {s.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Reports">
            {reports.map((r) => (
              <option key={r.id} value={`report:${r.id}`}>
                {r.name}
              </option>
            ))}
          </optgroup>
        </select>
      )}
    </Field>
  )
  const status = needsData && source && (data.loading ? <p className="builder-hint" role="status">Loading columns…</p> : data.error ? <p className="asset-warn" role="alert">{data.error}</p> : null)
  const filter = needsData && table && (
    <Field label="Only rows that match">
      {() => <FilterEditor columns={columns} value={config.filter as MetricConfig['filter']} onChange={(f) => setConfig({ filter: f })} what="Widget filter" />}
    </Field>
  )

  return (
    <Dialog
      wide
      title={`${WIDGET_LABEL[draft.type]} settings`}
      onClose={onCancel}
      footer={
        <>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={() => onApply(draft)}>
            Apply
          </button>
        </>
      }
    >
      <form className="widget-form" onSubmit={(e) => e.preventDefault()}>
        {draft.type !== 'title' && (
          <Field label="Widget title (optional)">
            {(id) => <input id={id} value={draft.title} maxLength={100} data-autofocus onChange={(e) => setDraft({ ...draft, title: e.target.value })} />}
          </Field>
        )}

        {draft.type === 'title' && (
          <>
            <Field label="Heading">{(id) => <input id={id} value={config.text as string} data-autofocus maxLength={200} onChange={(e) => setConfig({ text: e.target.value })} />}</Field>
            <Field label="Size">
              {(id) => (
                <select id={id} value={config.size as string} onChange={(e) => setConfig({ size: e.target.value })}>
                  <option value="large">Large</option>
                  <option value="medium">Medium</option>
                </select>
              )}
            </Field>
          </>
        )}

        {draft.type === 'text' && (
          <Field label="Text" hint="Use # for a heading, - for a list, **bold**, *italic* and [text](https://link).">
            {(id) => <textarea id={id} rows={7} value={config.text as string} maxLength={5000} onChange={(e) => setConfig({ text: e.target.value })} />}
          </Field>
        )}

        {draft.type === 'image' && (
          <>
            <Field label="Image address (https)">{(id) => <input id={id} type="url" value={config.url as string} placeholder="https://" onChange={(e) => setConfig({ url: e.target.value })} />}</Field>
            <Field label="Description for screen readers">{(id) => <input id={id} value={config.alt as string} onChange={(e) => setConfig({ alt: e.target.value })} />}</Field>
            <Field label="Link when clicked (optional)">{(id) => <input id={id} type="url" value={config.link as string} placeholder="https://" onChange={(e) => setConfig({ link: e.target.value })} />}</Field>
          </>
        )}

        {draft.type === 'shortcut' && (
          <Shortcuts links={config.links as ShortcutLink[]} onChange={(links) => setConfig({ links })} sheets={sheets} reports={reports} dashboards={dashboards} />
        )}

        {sourcePicker}
        {status}

        {draft.type === 'metric' && table && (
          <>
            <Field label="Show">
              {(id) => (
                <select id={id} value={config.mode as string} onChange={(e) => setConfig({ mode: e.target.value })}>
                  <option value="summary">A total of a column (or a count of rows)</option>
                  <option value="cell">The value of one cell</option>
                </select>
              )}
            </Field>
            {config.mode === 'summary' ? (
              <>
                <Field label="Calculate">
                  {(id) => (
                    <select id={id} value={config.fn as string} onChange={(e) => setConfig({ fn: e.target.value })}>
                      <option value="count">Count of rows</option>
                      <option value="sum">Sum</option>
                      <option value="avg">Average</option>
                      <option value="min">Smallest</option>
                      <option value="max">Largest</option>
                      <option value="percent">Percent of rows that match the filter</option>
                    </select>
                  )}
                </Field>
                {config.fn !== 'percent' && (
                  <Field label="Column" hint={config.fn === 'count' ? 'Leave empty to count every row; choose a column to count its filled cells.' : undefined}>
                    {(id) => <ColumnSelect id={id} columns={columns} value={config.column as string | null} onChange={(v) => setConfig({ column: v })} empty={config.fn === 'count' ? 'Every row' : undefined} />}
                  </Field>
                )}
                {filter}
              </>
            ) : (
              <>
                <Field label="Column">{(id) => <ColumnSelect id={id} columns={columns} value={config.column as string | null} onChange={(v) => setConfig({ column: v })} />}</Field>
                <Field label="Row">
                  {(id) => (
                    <select id={id} value={(config.rowId as string | null) ?? ''} onChange={(e) => setConfig({ rowId: e.target.value || null })}>
                      <option value="">Choose a row…</option>
                      {table.rows.slice(0, 300).map((r, i) => {
                        const first = table.columns.map((c) => formatValue(r.values[c.key], c.type)).find((t) => t.trim() !== '') ?? '(empty)'
                        return (
                          <option key={r.id} value={r.id}>{`${i + 1}. ${first.slice(0, 50)}`}</option>
                        )
                      })}
                    </select>
                  )}
                </Field>
              </>
            )}
            <div className="field-pair">
              <Field label="Before the number">{(id) => <input id={id} value={config.prefix as string} maxLength={12} placeholder="$" onChange={(e) => setConfig({ prefix: e.target.value })} />}</Field>
              <Field label="After the number">{(id) => <input id={id} value={config.suffix as string} maxLength={24} placeholder="days" onChange={(e) => setConfig({ suffix: e.target.value })} />}</Field>
            </div>
            <Field label="Number style">
              {(id) => (
                <select id={id} value={config.format as string} onChange={(e) => setConfig({ format: e.target.value })}>
                  <option value="auto">Plain</option>
                  <option value="percent">Percent (adds %)</option>
                </select>
              )}
            </Field>
          </>
        )}

        {draft.type === 'chart' && table && (
          <>
            <Field label="Chart type">
              {(id) => (
                <select id={id} value={config.kind as string} onChange={(e) => setConfig({ kind: e.target.value })}>
                  <option value="column">Column</option>
                  <option value="bar">Bar</option>
                  <option value="line">Line</option>
                  <option value="pie">Pie</option>
                  <option value="donut">Donut</option>
                  <option value="stacked">Stacked column</option>
                </select>
              )}
            </Field>
            <Field label="Group by (categories)" hint="Dates are grouped by month.">
              {(id) => <ColumnSelect id={id} columns={columns} value={config.category as string | null} onChange={(v) => setConfig({ category: v })} />}
            </Field>
            {config.kind === 'stacked' && (
              <Field label="Stack by">{(id) => <ColumnSelect id={id} columns={columns} value={config.stackBy as string | null} onChange={(v) => setConfig({ stackBy: v })} />}</Field>
            )}
            <div className="field-pair">
              <Field label="Value">
                {(id) => (
                  <select id={id} value={config.fn as string} onChange={(e) => setConfig({ fn: e.target.value })}>
                    <option value="count">Count of rows</option>
                    <option value="sum">Sum of a column</option>
                    <option value="avg">Average of a column</option>
                    <option value="min">Smallest of a column</option>
                    <option value="max">Largest of a column</option>
                  </select>
                )}
              </Field>
              {config.fn !== 'count' && (
                <Field label="Column">{(id) => <ColumnSelect id={id} columns={columns} value={config.value as string | null} onChange={(v) => setConfig({ value: v })} />}</Field>
              )}
            </div>
            <div className="field-pair">
              <Field label="Order">
                {(id) => (
                  <select id={id} value={config.order as string} onChange={(e) => setConfig({ order: e.target.value })}>
                    <option value="natural">By category</option>
                    <option value="value">Largest first</option>
                  </select>
                )}
              </Field>
              <Field label="Most categories shown">
                {(id) => <input id={id} type="number" min={2} max={50} value={config.limit as number} onChange={(e) => setConfig({ limit: Number(e.target.value) || 12 })} />}
              </Field>
            </div>
            {filter}
          </>
        )}

        {(draft.type === 'gantt' || draft.type === 'timeline') && table && (
          <>
            <Field label="Item name">{(id) => <ColumnSelect id={id} columns={columns} value={config.label as string | null} onChange={(v) => setConfig({ label: v })} />}</Field>
            <Field label="Start date">
              {(id) => <ColumnSelect id={id} columns={dateColumns} value={config.start as string | null} onChange={(v) => setConfig({ start: v })} />}
            </Field>
            <Field label="End date (optional)" hint="Without an end date an item is drawn as a milestone.">
              {(id) => <ColumnSelect id={id} columns={dateColumns} value={config.end as string | null} onChange={(v) => setConfig({ end: v })} empty="No end date" />}
            </Field>
            <Field label="Most items shown">
              {(id) => <input id={id} type="number" min={1} max={300} value={config.limit as number} onChange={(e) => setConfig({ limit: Number(e.target.value) || 100 })} />}
            </Field>
            {filter}
          </>
        )}

        <fieldset className="widget-position">
          <legend>Position and size on the {GRID_COLUMNS}-column grid</legend>
          <div className="field-quad">
            {([['x', 'Column', 0, GRID_COLUMNS - 1], ['y', 'Row', 0, 399], ['w', 'Width', 1, GRID_COLUMNS], ['h', 'Height', 1, MAX_HEIGHT]] as const).map(([k, label, min, max]) => (
              <Field key={k} label={label}>
                {(id) => <input id={id} type="number" min={min} max={max} value={draft[k] + (k === 'x' || k === 'y' ? 1 : 0)} onChange={(e) => setRect({ [k]: (Number(e.target.value) || 1) - (k === 'x' || k === 'y' ? 1 : 0) })} />}
              </Field>
            ))}
          </div>
        </fieldset>
      </form>
    </Dialog>
  )
}

function Shortcuts({
  links,
  onChange,
  sheets,
  reports,
  dashboards,
}: {
  links: ShortcutLink[]
  onChange: (l: ShortcutLink[]) => void
  sheets: { id: string; name: string }[]
  reports: { id: string; name: string }[]
  dashboards: { id: string; name: string }[]
}) {
  const [kind, setKind] = useState<ShortcutLink['kind']>('sheet')
  const [target, setTarget] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const list = kind === 'sheet' ? sheets : kind === 'report' ? reports : dashboards

  function add() {
    const t = kind === 'url' ? safeUrl(target) : target
    if (!t) {
      setError(kind === 'url' ? 'Enter a web address that starts with https://' : 'Choose an item')
      return
    }
    setError(null)
    onChange([...links, { kind, target: t, label: label.trim() }])
    setTarget('')
    setLabel('')
  }

  return (
    <div className="field">
      <span className="label">Links</span>
      <ul className="column-list">
        {links.map((l, i) => (
          <li key={i}>
            <span className="column-name">{l.label || (l.kind === 'url' ? l.target : (sheets.concat(reports, dashboards).find((x) => x.id === l.target)?.name ?? 'Missing item'))}</span>
            <span className="column-meta">{l.kind}</span>
            <button type="button" className="btn-icon is-danger" aria-label={`Remove link ${i + 1}`} onClick={() => onChange(links.filter((_, j) => j !== i))}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="builder-row">
        <select aria-label="Link to" value={kind} onChange={(e) => { setKind(e.target.value as ShortcutLink['kind']); setTarget('') }}>
          <option value="sheet">A sheet</option>
          <option value="report">A report</option>
          <option value="dashboard">A dashboard</option>
          <option value="url">A web page</option>
        </select>
        {kind === 'url' ? (
          <input aria-label="Web address" type="url" placeholder="https://" value={target} onChange={(e) => setTarget(e.target.value)} />
        ) : (
          <select aria-label="Item" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose…</option>
            {list.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        )}
        <input aria-label="Label (optional)" placeholder="Label (optional)" value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} />
        <button type="button" className="btn btn-sm" onClick={add}>
          Add link
        </button>
      </div>
      {error && <p role="alert" className="asset-warn">{error}</p>}
    </div>
  )
}

