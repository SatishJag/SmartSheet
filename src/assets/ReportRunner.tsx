import { useMemo } from 'react'
import { AssetIcon } from './AssetIcon'
import { defaultTime, emptyFilter } from './definition'
import { pickTimeColumns, reportToCsv } from './reportEngine'
import { ReportTable } from './ReportTable'
import type { SheetHub } from './sheetHub'
import { TimelineChart } from './TimelineChart'
import type { ReportMeta } from './types'
import { useAssetsApi, useAssets } from './useAssets'
import { useReportData } from './useReportData'
import { todayIso } from './values'
import { tableFromReport, timeItems } from './widgetData'

interface Props {
  report: ReportMeta
  hub: SheetHub
  onBack: () => void
  onEdit: () => void
  onOpenSheet: (id: string) => void
  /** Text of the back button ("Reports", or "Back" when opened from somewhere else). */
  backLabel?: string
}

/** Triggers a browser download of text as a file. */
export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob(['﻿', text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const safeFileName = (name: string) => name.replace(/[^\p{L}\p{N}._ -]+/gu, '').trim().replace(/\s+/g, '-') || 'report'

export function SaveBadge({ hub }: { hub: SheetHub }) {
  const status = hub.saveStatus()
  if (status === 'saved') return <span className="save-badge is-saved">All changes saved</span>
  if (status === 'failed') {
    return (
      <span className="save-badge is-failed" role="alert">
        Some changes did not save
        <button type="button" className="btn btn-sm" onClick={() => hub.retryFailed()}>
          Retry
        </button>
      </span>
    )
  }
  return <span className="save-badge" role="status">Saving…</span>
}

/**
 * A report, live: rows from its source sheets, filtered, sorted and grouped. A cell can be edited in
 * place and the edit is written to the source sheet (see ReportTable). Refresh reloads the sources.
 */
export function ReportRunner({ report, hub, onBack, onEdit, onOpenSheet, backLabel = 'Reports' }: Props) {
  const def = report.definition
  const data = useReportData(hub, def)
  const api = useAssetsApi()
  const favorites = useAssets((s) => s.favorites)
  const star = favorites.find((f) => f.kind === 'report' && f.targetId === report.id)
  const { result } = data

  const time = useMemo(() => {
    if (!def.gantt) return null
    const table = tableFromReport(result)
    const picked = pickTimeColumns(table.columns.map((c) => ({ ...c, virtual: false })))
    return { picked, data: timeItems(table, { ...defaultTime(), ...picked, filter: emptyFilter(), limit: 200 }, todayIso()) }
  }, [def.gantt, result])

  const sheetCount = def.sources.length
  return (
    <section className="asset-screen report-run">
      <header className="asset-head">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <button type="button" className="crumb-link" onClick={onBack}>
            <AssetIcon name="back" size={16} />
            {backLabel}
          </button>
          <AssetIcon name="chevron" size={14} className="crumb-sep" />
          <h2 className="asset-title">{report.name}</h2>
        </nav>
        <span className="spacer" />
        <SaveBadge hub={hub} />
        <button
          type="button"
          className="btn-icon"
          aria-pressed={!!star}
          aria-label={star ? `Remove ${report.name} from favorites` : `Add ${report.name} to favorites`}
          title={star ? 'Remove from favorites' : 'Add to favorites'}
          onClick={() => void api.getState().toggleFavorite('report', report.id)}
        >
          <AssetIcon name="star" filled={!!star} />
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void hub.reload()} disabled={data.loading}>
          <AssetIcon name="refresh" size={16} />
          Refresh
        </button>
        <button type="button" className="btn btn-sm" onClick={() => downloadText(`${safeFileName(report.name)}.csv`, reportToCsv(result))} disabled={result.rows.length === 0}>
          <AssetIcon name="download" size={16} />
          Export CSV
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={onEdit}>
          <AssetIcon name="pencil" size={16} />
          Edit report
        </button>
      </header>

      <p className="asset-meta" role="status">
        {data.loading
          ? 'Loading the source sheets…'
          : `${result.matched.toLocaleString()} of ${result.scanned.toLocaleString()} rows from ${sheetCount} ${sheetCount === 1 ? 'sheet' : 'sheets'}${result.groups ? `, in ${result.groups.length} groups` : ''}. Click a cell to edit it in the sheet it comes from.`}
      </p>
      {[...result.warnings, ...data.failed].map((w) => (
        <p key={w} className="asset-warn" role="status">
          <AssetIcon name="alert" size={16} /> {w}
        </p>
      ))}

      {def.sources.length === 0 || def.columns.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">
            <AssetIcon name="report" size={28} />
          </span>
          <p className="empty-title">This report is not set up yet</p>
          <p className="empty-text">Choose the sheets to pull rows from and the columns to show.</p>
          <button type="button" className="btn btn-primary" onClick={onEdit}>
            Set up report
          </button>
        </div>
      ) : (
        <div className="report-body">
          <ReportTable
            result={result}
            definition={def}
            sheets={data.sheets}
            label={`${report.name} rows`}
            onEdit={(sheetId, rowId, colId, raw) => hub.setCell(sheetId, rowId, colId, raw)}
            onOpenSheet={onOpenSheet}
          />
          {time && (
            <section className="report-gantt" aria-label="Gantt timeline">
              <h3>Timeline</h3>
              {time.data.items.length > 0 ? (
                <TimelineChart data={time.data} mode="gantt" label={`${report.name} timeline`} today={todayIso()} />
              ) : (
                <p className="asset-meta">The Gantt needs a start date and an end date column; add them to the report.</p>
              )}
            </section>
          )}
        </div>
      )}
    </section>
  )
}
