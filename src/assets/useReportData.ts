import { useEffect, useMemo } from 'react'
import { evaluateReport, type ReportResult } from './reportEngine'
import type { SheetHub } from './sheetHub'
import type { ReportDefinition, SourceSheet } from './types'
import { todayIso } from './values'

export interface ReportData {
  result: ReportResult
  sheets: ReadonlyMap<string, SourceSheet>
  /** Some source is still loading. */
  loading: boolean
  /** Sources that could not be loaded, with the reason. */
  failed: string[]
}

/**
 * Loads a report's source sheets into the hub and evaluates the report over them whenever the
 * definition or any source changes. `hub.version()` is read here so a component re-renders on edits.
 */
export function useReportData(hub: SheetHub, definition: ReportDefinition): ReportData {
  const sourceKey = definition.sources.join(',')
  useEffect(() => {
    void hub.load(definition.sources)
  }, [hub, sourceKey])

  const version = hub.version()
  return useMemo(() => {
    const found = definition.sources.flatMap((id) => {
      const s = hub.sheet(id)
      return s ? [s] : []
    })
    const result = evaluateReport(definition, found, { today: todayIso() })
    const loading = definition.sources.some((id) => {
      const state = hub.loadState(id)
      return state === undefined || state === 'loading'
    })
    const failed = definition.sources.flatMap((id) => (hub.loadState(id) === 'error' ? [`${hub.loadError(id) ?? 'could not be loaded'}`] : []))
    return { result, sheets: new Map(found.map((s) => [s.id, s])), loading, failed }
    // `version` changes whenever any source sheet changes (the memo must rerun then)
  }, [hub, definition, version])
}
