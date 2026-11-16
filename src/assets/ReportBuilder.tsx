import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ConfirmDialog } from '../views/ConfirmDialog'
import { AssetIcon } from './AssetIcon'
import { FilterEditor } from './FilterEditor'
import { MAX_SUMMARIES, reportProblems, SUMMARY_FNS } from './definition'
import { availableColumns, GROUP_LIMIT, SORT_LIMIT, type ResolvedColumn } from './reportEngine'
import { ReportTable } from './ReportTable'
import type { SheetHub } from './sheetHub'
import { MAX_SOURCES, type ReportDefinition, type ReportMeta, type SummaryFn } from './types'
import { useAssets, useAssetsApi } from './useAssets'
import { useReportData } from './useReportData'

interface Props {
  report: ReportMeta
  hub: SheetHub
  /** Leaves the builder; `saved` is true after a successful save. */
  onDone: (saved: boolean) => void
}

const FN_LABEL: Record<SummaryFn, string> = { sum: 'Sum', avg: 'Average', count: 'Count', min: 'Smallest', max: 'Largest' }
const REAL_COLUMN_DEFAULT = 8

/**
 * The report builder: pick the sheets, the columns, the filter, the sort, the grouping and the summaries,
 * with a live preview of the first rows. Nothing is saved until Save report.
 */
export function ReportBuilder({ report, hub, onDone }: Props) {
  const api = useAssetsApi()
  const sheets = useAssets((s) => s.sheets)
  const [name, setName] = useState(report.name)
  const [def, setDef] = useState<ReportDefinition>(report.definition)
  const [sheetQuery, setSheetQuery] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const touchedColumns = useRef(report.definition.columns.length > 0)
  const uid = useId()

  const data = useReportData(hub, def)
  const loaded = useMemo(() => [...data.sheets.values()], [data.sheets])
  const available = useMemo(() => availableColumns(loaded), [loaded])
  const byKey = useMemo(() => new Map(available.map((c) => [c.key, c])), [available])

  // A sensible start: the first time sources are loaded and nothing is chosen, show their first columns.
  useEffect(() => {
    if (touchedColumns.current || def.columns.length > 0 || loaded.length === 0) return
    const real = available.filter((c) => !c.virtual).slice(0, REAL_COLUMN_DEFAULT)
    if (real.length === 0) return
    touchedColumns.current = true
    setDef((d) => ({ ...d, columns: real.map((c) => ({ key: c.key, title: c.title })) }))
  }, [available, loaded.length, def.columns.length])

  const dirty = name !== report.name || JSON.stringify(def) !== JSON.stringify(report.definition)
  const problems = reportProblems(def)
  const patch = (p: Partial<ReportDefinition>) => setDef((d) => ({ ...d, ...p }))

  const chosen = new Set(def.columns.map((c) => c.key))
  const columnOptions = (list: ResolvedColumn[]) =>
    list.map((c) => (
      <option key={c.key} value={c.key}>
        {c.title}
      </option>
    ))
  const columnList = available.length > 0 ? available : def.columns.map((c) => ({ key: c.key, title: c.title, type: 'TEXT_NUMBER' as const, sheetCount: 0 }))

  function toggleSource(id: string) {
    const on = def.sources.includes(id)
    if (!on && def.sources.length >= MAX_SOURCES) return
    patch({ sources: on ? def.sources.filter((s) => s !== id) : [...def.sources, id] })
  }

  function move(i: number, by: -1 | 1) {
    const cols = [...def.columns]
    const j = i + by
    if (j < 0 || j >= cols.length) return
    ;[cols[i], cols[j]] = [cols[j], cols[i]]
    touchedColumns.current = true
    patch({ columns: cols })
  }

  async function save() {
    setSaving(true)
    setSaveError(null)
    const res = await api.getState().saveReport(report.id, { name, definition: def })
    setSaving(false)
    if (res.ok) onDone(true)
    else setSaveError(res.error)
  }

  const shownSheets = sheets.filter((s) => s.name.toLowerCase().includes(sheetQuery.trim().toLowerCase()))
  const addable = available.filter((c) => !chosen.has(c.key))
  const groupable = columnList

  return (
    <section className="asset-screen report-builder">
      {confirmLeave && (
        <ConfirmDialog
          title="Discard changes"
          message="This report has changes that are not saved. Leave without saving?"
          confirmLabel="Discard"
          onConfirm={() => onDone(false)}
          onCancel={() => setConfirmLeave(false)}
        />
      )}
      <header className="asset-head">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <button type="button" className="crumb-link" onClick={() => (dirty ? setConfirmLeave(true) : onDone(false))}>
            <AssetIcon name="back" size={16} />
            Back
          </button>
          <AssetIcon name="chevron" size={14} className="crumb-sep" />
          <label className="visually-hidden" htmlFor={`${uid}-name`}>
            Report name
          </label>
          <input id={`${uid}-name`} className="asset-name-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </nav>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving || problems.length > 0 || name.trim() === ''}>
          {saving ? 'Saving…' : 'Save report'}
        </button>
      </header>
      {saveError && (
        <p role="alert" className="list-error">
          {saveError}
        </p>
      )}

      <div className="builder-grid">
        <div className="builder-form">
          <fieldset className="builder-card">
            <legend>1. Sheets to pull rows from</legend>
            <p className="builder-hint">
              Choose up to {MAX_SOURCES} sheets. {def.sources.length} selected. Columns with the same name in different sheets become one column.
            </p>
            {sheets.length > 6 && (
              <input type="search" aria-label="Find a sheet" placeholder="Find a sheet" value={sheetQuery} onChange={(e) => setSheetQuery(e.target.value)} />
            )}
            {sheets.length === 0 ? (
              <p className="builder-hint">You have no sheets yet. Create one in Sheets first.</p>
            ) : (
              <ul className="check-list">
                {shownSheets.map((s) => {
                  const checked = def.sources.includes(s.id)
                  const state = hub.loadState(s.id)
                  return (
                    <li key={s.id}>
                      <label>
                        <input type="checkbox" checked={checked} disabled={!checked && def.sources.length >= MAX_SOURCES} onChange={() => toggleSource(s.id)} />
                        <span>{s.name}</span>
                        {checked && state === 'loading' && <span className="chip">Loading…</span>}
                        {checked && state === 'error' && <span className="chip is-danger">Could not load</span>}
                      </label>
                    </li>
                  )
                })}
              </ul>
            )}
          </fieldset>

          <fieldset className="builder-card">
            <legend>2. Columns to show</legend>
            {def.columns.length === 0 && <p className="builder-hint">{loaded.length === 0 ? 'Choose a sheet first.' : 'Add the columns you want to see.'}</p>}
            <ol className="column-list">
              {def.columns.map((c, i) => {
                const info = byKey.get(c.key)
                return (
                  <li key={c.key}>
                    <span className="column-name">{info?.title ?? c.title}</span>
                    <span className="column-meta">
                      {info?.virtual ? 'added by the report' : info ? `in ${info.sheetCount} of ${loaded.length} sheets` : 'not in the chosen sheets'}
                    </span>
                    <button type="button" className="btn-icon" aria-label={`Move ${c.title} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                      <AssetIcon name="up" size={16} />
                    </button>
                    <button type="button" className="btn-icon" aria-label={`Move ${c.title} down`} disabled={i === def.columns.length - 1} onClick={() => move(i, 1)}>
                      <AssetIcon name="down" size={16} />
                    </button>
                    <button
                      type="button"
                      className="btn-icon is-danger"
                      aria-label={`Remove ${c.title}`}
                      onClick={() => {
                        touchedColumns.current = true
                        patch({ columns: def.columns.filter((x) => x.key !== c.key) })
                      }}
                    >
                      <AssetIcon name="close" size={16} />
                    </button>
                  </li>
                )
              })}
            </ol>
            <div className="builder-row">
              <label className="visually-hidden" htmlFor={`${uid}-add`}>
                Add a column
              </label>
              <select
                id={`${uid}-add`}
                value=""
                disabled={addable.length === 0}
                onChange={(e) => {
                  const c = byKey.get(e.target.value)
                  if (!c) return
                  touchedColumns.current = true
                  patch({ columns: [...def.columns, { key: c.key, title: c.title }] })
                }}
              >
                <option value="">Add a column…</option>
                {columnOptions(addable)}
              </select>
              <button
                type="button"
                className="btn btn-sm"
                disabled={addable.length === 0}
                onClick={() => {
                  touchedColumns.current = true
                  patch({ columns: [...def.columns, ...addable.filter((c) => !c.virtual).map((c) => ({ key: c.key, title: c.title }))] })
                }}
              >
                Add all
              </button>
            </div>
          </fieldset>

          <fieldset className="builder-card">
            <legend>3. Filter rows</legend>
            <p className="builder-hint">Leave empty to show every row. Dates accept today, today+7 or today-3.</p>
            <FilterEditor columns={columnList} value={def.filter} onChange={(filter) => patch({ filter })} />
          </fieldset>

          <fieldset className="builder-card">
            <legend>4. Sort</legend>
            <ul className="filter-list">
              {def.sort.map((s, i) => (
                <li key={i} className="filter-row">
                  <select
                    aria-label={`Sort ${i + 1} column`}
                    value={s.column}
                    onChange={(e) => patch({ sort: def.sort.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)) })}
                  >
                    {columnOptions(columnList)}
                  </select>
                  <select
                    aria-label={`Sort ${i + 1} direction`}
                    value={s.dir}
                    onChange={(e) => patch({ sort: def.sort.map((x, j) => (j === i ? { ...x, dir: e.target.value as 'asc' | 'desc' } : x)) })}
                  >
                    <option value="asc">A to Z, oldest first, smallest first</option>
                    <option value="desc">Z to A, newest first, largest first</option>
                  </select>
                  <button type="button" className="btn-icon is-danger" aria-label={`Remove sort ${i + 1}`} onClick={() => patch({ sort: def.sort.filter((_, j) => j !== i) })}>
                    <AssetIcon name="close" size={16} />
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn btn-sm"
              disabled={columnList.length === 0 || def.sort.length >= SORT_LIMIT}
              onClick={() => patch({ sort: [...def.sort, { column: columnList.find((c) => !def.sort.some((s) => s.column === c.key))?.key ?? columnList[0].key, dir: 'asc' }] })}
            >
              <AssetIcon name="plus" size={16} />
              Add sort
            </button>
          </fieldset>

          <fieldset className="builder-card">
            <legend>5. Group and summarize</legend>
            <ul className="filter-list">
              {def.groupBy.map((g, i) => (
                <li key={i} className="filter-row">
                  <span className="builder-label">{i === 0 ? 'Group by' : 'Then by'}</span>
                  <select aria-label={`Group ${i + 1} column`} value={g} onChange={(e) => patch({ groupBy: def.groupBy.map((x, j) => (j === i ? e.target.value : x)) })}>
                    {columnOptions(groupable)}
                  </select>
                  <button type="button" className="btn-icon is-danger" aria-label={`Remove group ${i + 1}`} onClick={() => patch({ groupBy: def.groupBy.filter((_, j) => j !== i) })}>
                    <AssetIcon name="close" size={16} />
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn btn-sm"
              disabled={groupable.length === 0 || def.groupBy.length >= GROUP_LIMIT}
              onClick={() => patch({ groupBy: [...def.groupBy, groupable.find((c) => !def.groupBy.includes(c.key))?.key ?? groupable[0].key] })}
            >
              <AssetIcon name="plus" size={16} />
              Add grouping
            </button>
            <ul className="filter-list">
              {def.summaries.map((s, i) => (
                <li key={i} className="filter-row">
                  <select aria-label={`Summary ${i + 1} function`} value={s.fn} onChange={(e) => patch({ summaries: def.summaries.map((x, j) => (j === i ? { ...x, fn: e.target.value as SummaryFn } : x)) })}>
                    {SUMMARY_FNS.map((fn) => (
                      <option key={fn} value={fn}>
                        {FN_LABEL[fn]}
                      </option>
                    ))}
                  </select>
                  <span className="builder-label">of</span>
                  <select aria-label={`Summary ${i + 1} column`} value={s.column} onChange={(e) => patch({ summaries: def.summaries.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)) })}>
                    {columnOptions(columnList)}
                  </select>
                  <button type="button" className="btn-icon is-danger" aria-label={`Remove summary ${i + 1}`} onClick={() => patch({ summaries: def.summaries.filter((_, j) => j !== i) })}>
                    <AssetIcon name="close" size={16} />
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn btn-sm"
              disabled={columnList.length === 0 || def.summaries.length >= MAX_SUMMARIES}
              onClick={() => {
                const free = def.columns.find((c) => !def.summaries.some((s) => s.column === c.key))
                const col = free ? byKey.get(free.key) : undefined
                if (!free) return
                const numeric = col?.type === 'TEXT_NUMBER'
                patch({ summaries: [...def.summaries, { column: free.key, fn: numeric ? 'sum' : 'count' }] })
              }}
            >
              <AssetIcon name="plus" size={16} />
              Add summary
            </button>
          </fieldset>

          <fieldset className="builder-card">
            <legend>6. Gantt</legend>
            <label className="check-line">
              <input type="checkbox" checked={def.gantt} onChange={(e) => patch({ gantt: e.target.checked })} />
              <span>Also show the rows on a Gantt timeline (needs a start and an end date column)</span>
            </label>
          </fieldset>
        </div>

        <aside className="builder-preview" aria-label="Preview">
          <h3>Preview</h3>
          <p className="asset-meta" role="status">
            {problems.length > 0 ? problems.join(' ') : data.loading ? 'Loading…' : `${data.result.matched.toLocaleString()} rows match. Showing the first 50.`}
          </p>
          {[...data.result.warnings, ...data.failed].map((w) => (
            <p key={w} className="asset-warn" role="status">
              <AssetIcon name="alert" size={16} /> {w}
            </p>
          ))}
          {problems.length === 0 && (
            <ReportTable result={data.result} definition={def} sheets={data.sheets} label="Report preview" maxRows={50} />
          )}
        </aside>
      </div>
    </section>
  )
}
