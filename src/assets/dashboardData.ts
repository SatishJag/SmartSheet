import { useEffect, useMemo } from 'react'
import { layoutSources } from './definition'
import { evaluateReport } from './reportEngine'
import type { SheetHub } from './sheetHub'
import type { DashboardLayout, ReportMeta, SourceRef } from './types'
import { useAssets } from './useAssets'
import { todayIso } from './values'
import { tableFromReport, tableFromSheet, type Table } from './widgetData'

/** What a widget can read: the table behind its source, or why there is none yet. */
export interface DataSource {
  table: Table | null
  loading: boolean
  error: string | null
}

const NONE: DataSource = { table: null, loading: false, error: null }

/** The sheet ids a source needs loaded: the sheet itself, or the sheets a report pulls from. */
export function sheetIdsOf(ref: SourceRef | null, reports: readonly ReportMeta[]): string[] {
  if (!ref) return []
  if (ref.type === 'sheet') return [ref.id]
  return reports.find((r) => r.id === ref.id)?.definition.sources ?? []
}

/** The table of one source (a sheet, or a report evaluated over its sheets), read from the hub. Pure given the hub's current state. */
export function tableForRef(hub: SheetHub, ref: SourceRef | null, reports: readonly ReportMeta[]): DataSource {
  if (!ref) return NONE
  if (ref.type === 'report' && !reports.some((r) => r.id === ref.id)) return { table: null, loading: false, error: 'This report no longer exists.' }
  const ids = sheetIdsOf(ref, reports)
  const states = ids.map((id) => hub.loadState(id))
  const failed = ids.find((id) => hub.loadState(id) === 'error')
  if (failed) return { table: null, loading: false, error: hub.loadError(failed) ?? 'A source sheet could not be loaded.' }
  if (states.some((s) => s === undefined || s === 'loading')) return { table: null, loading: true, error: null }
  if (ref.type === 'sheet') {
    const sheet = hub.sheet(ref.id)
    return sheet ? { table: tableFromSheet(sheet), loading: false, error: null } : { table: null, loading: false, error: 'This sheet no longer exists.' }
  }
  const report = reports.find((r) => r.id === ref.id)!
  const sheets = ids.flatMap((id) => hub.sheet(id) ?? [])
  return { table: tableFromReport(evaluateReport(report.definition, sheets, { today: todayIso() })), loading: false, error: null }
}

/** Loads whatever the given sources need and returns their tables, re-evaluated when any source sheet changes. */
export function useSources(hub: SheetHub, refs: readonly SourceRef[]): (ref: SourceRef | null) => DataSource {
  const reports = useAssets((s) => s.reports)
  const key = refs.map((r) => `${r.type}:${r.id}`).join('|')
  const ids = useMemo(
    () => [...new Set(refs.flatMap((r) => sheetIdsOf(r, reports)))],
    [key, reports],
  )
  useEffect(() => {
    if (ids.length > 0) void hub.load(ids)
  }, [hub, ids])
  const version = hub.version()
  const tables = useMemo(() => {
    const map = new Map<string, DataSource>()
    for (const r of refs) map.set(`${r.type}:${r.id}`, tableForRef(hub, r, reports))
    return map
  }, [hub, key, reports, version])
  return (ref) => (ref ? (tables.get(`${ref.type}:${ref.id}`) ?? NONE) : NONE)
}

/** The sources a layout reads. */
export const refsOf = (layout: DashboardLayout) => layoutSources(layout)
