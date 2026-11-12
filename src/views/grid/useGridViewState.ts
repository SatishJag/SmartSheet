import { useMemo, useState } from 'react'
import type { FilterSpec, SortSpec, ViewState } from './viewModel'

/** UI-only view state for the grid: collapsed rows, one sort column, one filter. */
export function useGridViewState() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [sort, setSort] = useState<SortSpec | null>(null)
  const [filter, setFilter] = useState<FilterSpec | null>(null)
  const view = useMemo<ViewState>(() => ({ collapsed, sort, filter }), [collapsed, sort, filter])

  function toggleCollapsed(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  function expand(id: string) {
    setCollapsed((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  /** Header click: asc -> desc -> none; a different column starts at asc. */
  function cycleSort(colId: string) {
    setSort((prev) => {
      if (prev?.colId !== colId) return { colId, dir: 'asc' }
      return prev.dir === 'asc' ? { colId, dir: 'desc' } : null
    })
  }

  return { view, toggleCollapsed, expand, cycleSort, setFilter }
}
