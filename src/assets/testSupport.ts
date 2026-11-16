import type { ColumnType } from '../model/validate'
import type { ReportDefinition, SourceSheet } from './types'

/** Test helpers: tiny in-memory sheets and report definitions. Only tests import this file. */

export type TableColumn = [title: string, type?: ColumnType, options?: string[]]

/** A SourceSheet from rows of plain values (one array per row, in column order). Row ids are `r1`, `r2`, ... */
export function sheetFromTable(
  id: string,
  name: string,
  columns: TableColumn[],
  rows: unknown[][],
  opts: { readOnly?: (rowId: string, colId: string) => string | null } = {},
): SourceSheet {
  const cols = columns.map(([title, type = 'TEXT_NUMBER', options], i) => ({ id: `${id}-c${i}`, title, type, options }))
  const rowIds = rows.map((_, i) => `r${i + 1}`)
  const cells = new Map<string, unknown>()
  rows.forEach((r, i) => cols.forEach((c, j) => cells.set(`${rowIds[i]}|${c.id}`, r[j] ?? null)))
  return {
    id,
    name,
    columns: cols,
    rowIds,
    value: (rowId, colId) => cells.get(`${rowId}|${colId}`) ?? null,
    isBlankRow: (rowId) => cols.every((c) => cells.get(`${rowId}|${c.id}`) == null),
    readOnlyReason: (rowId, colId) => opts.readOnly?.(rowId, colId) ?? null,
    rawText: (rowId, colId) => String(cells.get(`${rowId}|${colId}`) ?? ''),
  }
}

export function reportDef(patch: Partial<ReportDefinition> = {}): ReportDefinition {
  return {
    sources: [],
    columns: [],
    filter: { match: 'all', conditions: [] },
    sort: [],
    groupBy: [],
    summaries: [],
    gantt: false,
    ...patch,
  }
}
