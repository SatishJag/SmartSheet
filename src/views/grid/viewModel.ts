import type { ScheduleResult } from '../../engine/schedule'
import { fullOrder } from '../../model/hierarchy'
import type { Column } from '../../model/validate'
import type { SheetData } from '../../store/persistence'
import { predecessorStrings } from '../../store/predecessors'
import { displayText, toEditString, type GridRow } from './columns'

/**
 * The grid's view model: which rows display, in what order, at what depth. Pure; the view
 * state (collapsed rows, one sort, one filter) is UI-only and never reaches the store.
 */

export type FilterOp = 'contains' | 'equals' | 'notEquals' | 'greaterThan' | 'lessThan' | 'isEmpty' | 'isNotEmpty'

export const FILTER_OPS: readonly { op: FilterOp; label: string }[] = [
  { op: 'contains', label: 'contains' },
  { op: 'equals', label: 'equals' },
  { op: 'notEquals', label: 'does not equal' },
  { op: 'greaterThan', label: 'greater than' },
  { op: 'lessThan', label: 'less than' },
  { op: 'isEmpty', label: 'is empty' },
  { op: 'isNotEmpty', label: 'is not empty' },
]

/** Operators that take no value. */
export const isValueless = (op: FilterOp) => op === 'isEmpty' || op === 'isNotEmpty'

export interface SortSpec {
  colId: string
  dir: 'asc' | 'desc'
}

export interface FilterSpec {
  colId: string
  op: FilterOp
  value: string
}

export interface ViewState {
  collapsed: ReadonlySet<string>
  sort: SortSpec | null
  filter: FilterSpec | null
}

export interface DisplayRow {
  id: string
  depth: number
  /** True 1-based position in the whole sheet's tree order, whatever the sort or filter. */
  rowNumber: number
  hasChildren: boolean
  expanded: boolean
}

/** Every row as the grid sees it, in tree order. */
export function buildGridRows(data: SheetData | null, scheduled: ScheduleResult): GridRow[] {
  if (!data) return []
  const byId = new Map(data.rows.map((r) => [r.id, r]))
  const parents = new Set(data.rows.map((r) => r.parentId).filter((p) => p !== null))
  const schedErrors = new Map<string, string[]>()
  for (const e of scheduled.errors) schedErrors.set(e.rowId, [...(schedErrors.get(e.rowId) ?? []), e.message])
  const preds = predecessorStrings(data)
  return fullOrder(data.rows).map((id, i) => ({
    id,
    rowNumber: i + 1,
    isParent: parents.has(id),
    record: byId.get(id)!,
    scheduled: scheduled.byRow[id],
    scheduleError: schedErrors.get(id)?.join('; ') ?? null,
    predecessors: preds.get(id) ?? '',
  }))
}

/** The sort that applies: null when there is none or its column does not exist. */
export function effectiveSort(columns: Column[], sort: SortSpec | null): { col: Column; dir: SortSpec['dir'] } | null {
  const col = sort && columns.find((c) => c.id === sort.colId)
  return col ? { col, dir: sort!.dir } : null
}

/** The filter that applies: null when there is none, its column does not exist, or it lacks a value. */
export function effectiveFilter(columns: Column[], filter: FilterSpec | null): (FilterSpec & { col: Column }) | null {
  if (!filter) return null
  const col = columns.find((c) => c.id === filter.colId)
  if (!col || !FILTER_OPS.some((o) => o.op === filter.op)) return null
  if (!isValueless(filter.op) && filter.value.trim() === '') return null
  return { ...filter, col }
}

/**
 * The rows to display. Sorting orders each sibling group (children stay under their parent);
 * filtering keeps matching rows and their ancestors, and while active overrides collapse.
 * Pass `gridRows` (from `buildGridRows`) to avoid rebuilding them.
 */
export function buildDisplayRows(
  data: SheetData | null,
  scheduled: ScheduleResult,
  view: ViewState,
  gridRows: GridRow[] = buildGridRows(data, scheduled),
): DisplayRow[] {
  if (!data) return []
  const ids = new Set(gridRows.map((r) => r.id))
  const children = new Map<string | null, GridRow[]>()
  for (const r of gridRows) {
    const p = r.record.parentId !== null && ids.has(r.record.parentId) ? r.record.parentId : null
    const list = children.get(p)
    if (list) list.push(r)
    else children.set(p, [r])
  }

  const sort = effectiveSort(data.columns, view.sort)
  if (sort) for (const [p, list] of children) children.set(p, sortSiblings(list, sort.col, sort.dir))

  const filter = effectiveFilter(data.columns, view.filter)
  let keep: Set<string> | null = null
  if (filter) {
    const kept = new Set<string>()
    const visit = (r: GridRow): boolean => {
      let any = matchesFilter(filter.col, filter, r)
      for (const c of children.get(r.id) ?? []) if (visit(c)) any = true
      if (any) kept.add(r.id)
      return any
    }
    for (const r of children.get(null) ?? []) visit(r)
    keep = kept
  }

  const out: DisplayRow[] = []
  const walk = (parentId: string | null, depth: number): void => {
    for (const r of children.get(parentId) ?? []) {
      if (keep && !keep.has(r.id)) continue
      const hasChildren = (children.get(r.id)?.length ?? 0) > 0
      const expanded = hasChildren && (keep !== null || !view.collapsed.has(r.id))
      out.push({ id: r.id, depth, rowNumber: r.rowNumber, hasChildren, expanded })
      if (expanded) walk(r.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/** True if `id` lies beneath `ancestorId` (not the row itself). */
export function isDescendant(parentOf: (id: string) => string | null | undefined, ancestorId: string, id: string): boolean {
  const seen = new Set<string>()
  let cur = parentOf(id)
  while (cur && !seen.has(cur)) {
    if (cur === ancestorId) return true
    seen.add(cur)
    cur = parentOf(cur)
  }
  return false
}

// ---- sorting ----

/** A comparable sort key: numbers sort before dates, dates before text. */
type SortKey = { kind: 0; n: number } | { kind: 1 | 2; s: string }

function sortKey(col: Column, row: GridRow): SortKey | null {
  let value: unknown = col.role === 'predecessor' ? row.predecessors : row.record.cells[col.id]
  if (row.scheduled && (col.role === 'start' || col.role === 'end')) value = row.scheduled[col.role]
  if (col.type === 'CHECKBOX') return { kind: 0, n: value === true ? 1 : 0 }
  if (typeof value === 'number') return Number.isFinite(value) ? { kind: 0, n: value } : null
  const s = toEditString(value).trim()
  if (s === '') return null
  if (col.type === 'DATE') return { kind: 1, s }
  const n = Number(s)
  return Number.isFinite(n) ? { kind: 0, n } : { kind: 2, s }
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (a.kind !== b.kind) return a.kind - b.kind
  if (a.kind === 0) return a.n - (b as typeof a).n
  const bs = (b as { s: string }).s
  if (a.kind === 1) return a.s < bs ? -1 : a.s > bs ? 1 : 0
  return a.s.localeCompare(bs, undefined, { numeric: true })
}

/** Stable sort of one sibling group; blanks go last in both directions. */
function sortSiblings(list: GridRow[], col: Column, dir: SortSpec['dir']): GridRow[] {
  const sign = dir === 'asc' ? 1 : -1
  return list
    .map((row, i) => ({ row, i, key: sortKey(col, row) }))
    .sort((a, b) => {
      if (a.key === null || b.key === null) return a.key === b.key ? a.i - b.i : a.key === null ? 1 : -1
      return sign * compareKeys(a.key, b.key) || a.i - b.i
    })
    .map((x) => x.row)
}

// ---- filtering ----

const NUMBER = /^-?\d+(\.\d+)?%?$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/

function asNumber(s: string): number | null {
  return NUMBER.test(s) ? parseFloat(s) : null
}

/** Compare a displayed value with a filter value: numerically, as dates, or as text. Null if `text` is blank. */
function compareValues(text: string, value: string): number | null {
  if (text === '') return null
  const a = asNumber(text)
  const b = asNumber(value)
  if (a !== null && b !== null) return a - b
  if (ISO_DATE.test(text) && ISO_DATE.test(value)) {
    const x = text.slice(0, 10)
    const y = value.slice(0, 10)
    return x < y ? -1 : x > y ? 1 : 0
  }
  return text.localeCompare(value, undefined, { sensitivity: 'base', numeric: true })
}

/** Match a row's displayed value (scheduled dates and roll-ups included) against the filter. */
function matchesFilter(col: Column, filter: FilterSpec, row: GridRow): boolean {
  const checked = col.type === 'CHECKBOX' && row.record.cells[col.id] === true
  const text = col.type === 'CHECKBOX' ? String(checked) : displayText(col, row).trim()
  const blank = col.type === 'CHECKBOX' ? !checked : text === ''
  const value = filter.value.trim()
  switch (filter.op) {
    case 'isEmpty':
      return blank
    case 'isNotEmpty':
      return !blank
    case 'contains':
      return text.toLowerCase().includes(value.toLowerCase())
    case 'equals':
      return compareValues(text, value) === 0
    case 'notEquals':
      return compareValues(text, value) !== 0
    case 'greaterThan':
      return (compareValues(text, value) ?? 0) > 0
    case 'lessThan':
      return (compareValues(text, value) ?? 0) < 0
  }
}
