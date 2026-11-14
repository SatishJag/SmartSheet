import { useMemo } from 'react'
import { analyzeCriticalPath, type CriticalPathResult } from '../engine/criticalPath'
import { useSheetStore, useSheetStoreApi } from './SheetStoreContext'
import { toSchedInput } from './scheduleInput'

/**
 * Critical path and float for the open sheet, or null when `enabled` is false, dependencies are
 * off, or the sheet cannot be scheduled. Computed only while enabled, and only when the schedule
 * changes (a save bumping a row's version does not recompute it).
 */
export function useCriticalPath(enabled: boolean): CriticalPathResult | null {
  const api = useSheetStoreApi()
  const scheduled = useSheetStore((s) => s.scheduled)
  const dependenciesEnabled = useSheetStore((s) => s.data?.sheet.dependenciesEnabled ?? false)
  return useMemo(() => {
    if (!enabled || !dependenciesEnabled) return null
    const data = api.getState().data
    const input = data && toSchedInput(data)
    return input ? analyzeCriticalPath(input.rows, input.deps, input.calendar, scheduled) : null
  }, [api, enabled, dependenciesEnabled, scheduled])
}
