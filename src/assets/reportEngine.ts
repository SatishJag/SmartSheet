import type { ColumnType } from '../model/validate'
import type { Condition, ReportDefinition, ReportFilter, SourceSheet, SummaryFn } from './types'
import {
  addDays,
  compareKeys,
  compareWithBlanks,
  formatValue,
  isBlank,
  isIsoDate,
  resolveDateToken,
  sortKeyOf,
  toNumber,
  type SortKey,
} from './values'

/**
 * The report engine: evaluates a report definition over loaded sheets. Pure and synchronous, so it is
 * unit-tested without a UI or a backend, and fast enough for 10 sources of 5,000 rows each.
 *
 * Columns of different sheets are matched by TITLE (trimmed, case-insensitive): "Task" in sheet A and
 * "task" in sheet B are one report column. A sheet without the column shows a blank there.
 */

export const SHEET_KEY = 'v:sheet'
export const ROW_KEY = 'v:row'

/** The report column key for a sheet column title. */
export const colKey = (title: string) => `c:${title.trim().toLowerCase()}`

export interface ResolvedColumn {
  key: string
  title: string
  type: ColumnType
  options?: string[]
  /** True for the built-in Sheet and Row columns. */
  virtual?: boolean
  /** How many of the source sheets have this column. */
  sheetCount: number
}

export interface ReportRow {
  /** `sheetId:rowId`, unique across the report. */
  id: string
  sheetId: string
  sheetName: string
  rowId: string
  /** 1-based position of the row in its sheet. */
  rowNumber: number
  /** Values of every column the report uses (displayed, filtered, sorted, grouped or summarised). */
  values: Record<string, unknown>
}

export type SummaryValue = number | string | null

export interface ReportGroup {
  /** Path of column keys and labels, unique within the report. */
  id: string
  column: string
  label: string
  /** Rows in the group, including those of subgroups. */
  count: number
  summaries: Record<string, SummaryValue>
  groups?: ReportGroup[]
  rows?: ReportRow[]
}

export interface ReportResult {
  /** The columns to display, in order. */
  columns: ResolvedColumn[]
  /** Filtered and sorted rows; in group order when the report is grouped. */
  rows: ReportRow[]
  groups: ReportGroup[] | null
  /** Summary of each summarised column over all matching rows. */
  totals: Record<string, SummaryValue>
  /** Rows read from the sources (skipping empty rows) and rows that passed the filter. */
  scanned: number
  matched: number
  warnings: string[]
  /** For each sheet id, the sheet column id behind each real report column key. */
  mapping: Record<string, Record<string, string>>
}

export const SORT_LIMIT = 3
export const GROUP_LIMIT = 2

// ---- columns ----

const mergeType = (a: ColumnType, b: ColumnType): ColumnType => (a === b ? a : 'TEXT_NUMBER')

/** The columns the given sheets offer: Sheet and Row, then every distinct title in first-seen order. */
export function availableColumns(sheets: readonly SourceSheet[]): ResolvedColumn[] {
  const out = new Map<string, ResolvedColumn>()
  out.set(SHEET_KEY, { key: SHEET_KEY, title: 'Sheet', type: 'TEXT_NUMBER', virtual: true, sheetCount: sheets.length })
  out.set(ROW_KEY, { key: ROW_KEY, title: 'Row', type: 'TEXT_NUMBER', virtual: true, sheetCount: sheets.length })
  for (const sheet of sheets) {
    const seen = new Set<string>()
    for (const col of sheet.columns) {
      const key = colKey(col.title)
      if (seen.has(key)) continue // a repeated title inside one sheet maps to its first column
      seen.add(key)
      const have = out.get(key)
      if (!have) {
        out.set(key, { key, title: col.title.trim(), type: col.type, options: col.options ? [...col.options] : undefined, sheetCount: 1 })
      } else {
        have.sheetCount++
        have.type = mergeType(have.type, col.type)
        if (col.options) have.options = [...new Set([...(have.options ?? []), ...col.options])]
        if (have.type !== col.type || have.type === 'TEXT_NUMBER') have.options = undefined
      }
    }
  }
  return [...out.values()]
}

/** The sheet column behind each report key in one sheet (first column with that title). */
function sheetMapping(sheet: SourceSheet, keys: Iterable<string>): Record<string, string> {
  const wanted = new Set(keys)
  const map: Record<string, string> = {}
  for (const col of sheet.columns) {
    const key = colKey(col.title)
    if (wanted.has(key) && !(key in map)) map[key] = col.id
  }
  return map
}

// ---- filters ----

type Values = Record<string, unknown>
export type RowPredicate = (values: Values) => boolean

/** Compare two values as numbers when both are numeric, else as dates, else as text. Null = not comparable. */
function compareFor(type: ColumnType | undefined, a: unknown, b: string): number | null {
  const ka: SortKey | null = sortKeyOf(a, type)
  if (ka === null) return null
  const kb = type === 'CHECKBOX' ? null : sortKeyOf(b, type)
  if (kb === null) return null
  return ka.k === kb.k ? compareKeys(ka, kb) : null
}

const norm = (s: string) => s.trim().toLowerCase()

function isMatch(value: unknown, type: ColumnType | undefined, target: string): boolean {
  if (type === 'CHECKBOX') return (value === true) === ['true', 'yes', 'checked', '1'].includes(norm(target))
  if (Array.isArray(value)) return value.some((v) => norm(String(v)) === norm(target))
  const c = compareFor(type, value, target)
  if (c !== null) return c === 0
  return norm(formatValue(value, type)) === norm(target)
}

/** Whether one condition holds for a value; `today` resolves date tokens. */
export function conditionMatches(cond: Condition, value: unknown, type: ColumnType | undefined, today: string): boolean {
  const a = type === 'DATE' ? resolveDateToken(cond.value, today) : cond.value.trim()
  const b = type === 'DATE' ? resolveDateToken(cond.value2, today) : cond.value2.trim()
  switch (cond.op) {
    case 'blank':
      return isBlank(value, type)
    case 'notBlank':
      return !isBlank(value, type)
    case 'is':
      return a === '' ? isBlank(value, type) : isMatch(value, type, a)
    case 'isNot':
      return a === '' ? !isBlank(value, type) : !isMatch(value, type, a)
    case 'contains':
      return a === '' || norm(formatValue(value, type)).includes(norm(a))
    case 'notContains':
      return a === '' || !norm(formatValue(value, type)).includes(norm(a))
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (a === '') return true // an unfinished condition filters nothing
      const c = compareFor(type, value, a)
      if (c === null) return false
      return cond.op === 'gt' ? c > 0 : cond.op === 'gte' ? c >= 0 : cond.op === 'lt' ? c < 0 : c <= 0
    }
    case 'between': {
      if (a === '' || b === '') return true
      const lo = compareFor(type, value, a)
      const hi = compareFor(type, value, b)
      return lo !== null && hi !== null && lo >= 0 && hi <= 0
    }
    case 'lastDays':
    case 'nextDays': {
      const n = Number(a)
      if (!Number.isInteger(n) || n < 0) return true
      if (typeof value !== 'string' || !isIsoDate(value)) return false
      const [from, to] = cond.op === 'lastDays' ? [addDays(today, -n), today] : [today, addDays(today, n)]
      return value >= from && value <= to
    }
  }
}

/** A row predicate for a filter. A condition on an unknown column sees a blank, so it only matches blank tests. */
export function compileFilter(filter: ReportFilter, columns: ReadonlyMap<string, { type: ColumnType }>, today: string): RowPredicate {
  const conditions = filter.conditions
  if (conditions.length === 0) return () => true
  const any = filter.match === 'any'
  return (values) => {
    for (const c of conditions) {
      const ok = conditionMatches(c, values[c.column] ?? null, columns.get(c.column)?.type, today)
      if (any && ok) return true
      if (!any && !ok) return false
    }
    return !any
  }
}

// ---- summaries ----

const tidy = (n: number) => Math.round(n * 1e10) / 1e10

/** count = non-blank values; sum and avg use the numeric ones; min and max also order dates and text. */
export function summarize(values: readonly unknown[], fn: SummaryFn, type?: ColumnType): SummaryValue {
  switch (fn) {
    case 'count':
      return values.reduce<number>((n, v) => n + (isBlank(v, type) ? 0 : 1), 0)
    case 'sum':
    case 'avg': {
      let sum = 0
      let n = 0
      for (const v of values) {
        const x = toNumber(v)
        if (x !== null) {
          sum += x
          n++
        }
      }
      return n === 0 ? null : tidy(fn === 'sum' ? sum : sum / n)
    }
    case 'min':
    case 'max': {
      let best: SortKey | null = null
      for (const v of values) {
        const k = sortKeyOf(v, type)
        if (k === null) continue
        if (best === null || compareWithBlanks(k, best, fn === 'min' ? 'asc' : 'desc') < 0) best = k
      }
      return best === null ? null : best.k === 0 ? best.n : best.s
    }
  }
}

// ---- evaluation ----

function neededKeys(def: ReportDefinition): string[] {
  const keys = new Set<string>()
  for (const c of def.columns) keys.add(c.key)
  for (const c of def.filter.conditions) keys.add(c.column)
  for (const s of def.sort) keys.add(s.column)
  for (const g of def.groupBy) keys.add(g)
  for (const s of def.summaries) keys.add(s.column)
  return [...keys]
}

const BLANK_LABEL = '(Blank)'

export function evaluateReport(def: ReportDefinition, sheets: readonly SourceSheet[], opts: { today: string }): ReportResult {
  const warnings: string[] = []
  const byId = new Map(sheets.map((s) => [s.id, s]))
  const used: SourceSheet[] = []
  for (const id of def.sources) {
    const sheet = byId.get(id)
    if (sheet) used.push(sheet)
    else warnings.push('A source sheet is no longer available (deleted or not loaded).')
  }
  const available = availableColumns(used)
  const byKey = new Map(available.map((c) => [c.key, c]))
  const typeOf = (key: string) => byKey.get(key)?.type

  const columns: ResolvedColumn[] = def.columns.map(
    (c) => byKey.get(c.key) ?? { key: c.key, title: c.title, type: 'TEXT_NUMBER' as ColumnType, sheetCount: 0 },
  )
  for (const c of columns) {
    if (c.sheetCount === 0 && used.length > 0) warnings.push(`No source sheet has a column called "${c.title}".`)
  }
  const keys = neededKeys(def)
  for (const key of keys) {
    if (!byKey.has(key) && !columns.some((c) => c.key === key) && used.length > 0) {
      const title = def.columns.find((c) => c.key === key)?.title ?? key.replace(/^c:/, '')
      warnings.push(`A filter, sort or group refers to a column that no source has: "${title}".`)
    }
  }

  const matches = compileFilter(def.filter, byKey, opts.today)
  const mapping: Record<string, Record<string, string>> = {}
  const rows: ReportRow[] = []
  let scanned = 0

  for (const sheet of used) {
    const map = sheetMapping(sheet, keys)
    mapping[sheet.id] = map
    const lookups = keys.map((key) => [key, map[key]] as const)
    sheet.rowIds.forEach((rowId, i) => {
      if (sheet.isBlankRow?.(rowId)) return
      scanned++
      const values: Values = {}
      for (const [key, colId] of lookups) {
        values[key] = key === SHEET_KEY ? sheet.name : key === ROW_KEY ? i + 1 : colId === undefined ? null : sheet.value(rowId, colId)
      }
      if (!matches(values)) return
      rows.push({ id: `${sheet.id}:${rowId}`, sheetId: sheet.id, sheetName: sheet.name, rowId, rowNumber: i + 1, values })
    })
  }
  const matched = rows.length

  const sorted = sortRows(rows, def.sort.slice(0, SORT_LIMIT), typeOf)
  const groupBy = def.groupBy.slice(0, GROUP_LIMIT)
  const summaries = def.summaries
  const summaryOf = (list: readonly ReportRow[]) => {
    const out: Record<string, SummaryValue> = {}
    for (const s of summaries) {
      out[s.column] = summarize(
        list.map((r) => r.values[s.column]),
        s.fn,
        typeOf(s.column),
      )
    }
    return out
  }

  let groups: ReportGroup[] | null = null
  let ordered = sorted
  if (groupBy.length > 0) {
    groups = buildGroups(sorted, groupBy, 0, '', def.sort, typeOf, summaryOf)
    ordered = flatten(groups)
  }
  return { columns, rows: ordered, groups, totals: summaryOf(sorted), scanned, matched, warnings: [...new Set(warnings)], mapping }
}

function sortRows(rows: ReportRow[], sorts: ReportDefinition['sort'], typeOf: (key: string) => ColumnType | undefined): ReportRow[] {
  if (sorts.length === 0) return rows
  const entries = rows.map((row, i) => ({ row, i, keys: sorts.map((s) => sortKeyOf(row.values[s.column], typeOf(s.column))) }))
  entries.sort((a, b) => {
    for (let n = 0; n < sorts.length; n++) {
      const c = compareWithBlanks(a.keys[n], b.keys[n], sorts[n].dir)
      if (c !== 0) return c
    }
    return a.i - b.i
  })
  return entries.map((e) => e.row)
}

function buildGroups(
  rows: readonly ReportRow[],
  groupBy: readonly string[],
  level: number,
  path: string,
  sort: ReportDefinition['sort'],
  typeOf: (key: string) => ColumnType | undefined,
  summaryOf: (rows: readonly ReportRow[]) => Record<string, SummaryValue>,
): ReportGroup[] {
  const column = groupBy[level]
  const type = typeOf(column)
  const buckets = new Map<string, { label: string; key: SortKey | null; rows: ReportRow[] }>()
  for (const row of rows) {
    const label = formatValue(row.values[column], type).trim() || BLANK_LABEL
    let bucket = buckets.get(label)
    if (!bucket) {
      bucket = { label, key: label === BLANK_LABEL ? null : sortKeyOf(row.values[column], type), rows: [] }
      buckets.set(label, bucket)
    }
    bucket.rows.push(row)
  }
  const dir = sort.find((s) => s.column === column)?.dir ?? 'asc'
  const ordered = [...buckets.values()].sort((a, b) => compareWithBlanks(a.key, b.key, dir))
  return ordered.map((b) => {
    const id = `${path}/${column}=${b.label}`
    const group: ReportGroup = { id, column, label: b.label, count: b.rows.length, summaries: summaryOf(b.rows) }
    if (level + 1 < groupBy.length) group.groups = buildGroups(b.rows, groupBy, level + 1, id, sort, typeOf, summaryOf)
    else group.rows = b.rows
    return group
  })
}

function flatten(groups: readonly ReportGroup[]): ReportRow[] {
  return groups.flatMap((g) => (g.groups ? flatten(g.groups) : (g.rows ?? [])))
}

// ---- write-back ----

export type WriteBack = { ok: true; sheetId: string; rowId: string; colId: string } | { ok: false; reason: string }

/**
 * Where an edit of one report cell goes: the source sheet, row and column behind it. Fails for the
 * built-in Sheet and Row columns, for a sheet that has no such column, and for a cell the source
 * sheet itself would not let you edit (a scheduled date, a roll-up).
 */
export function resolveWriteBack(
  result: Pick<ReportResult, 'mapping'>,
  sheets: ReadonlyMap<string, SourceSheet>,
  row: Pick<ReportRow, 'sheetId' | 'rowId'>,
  key: string,
): WriteBack {
  if (key === SHEET_KEY || key === ROW_KEY) return { ok: false, reason: 'This column is added by the report and cannot be edited' }
  const colId = result.mapping[row.sheetId]?.[key]
  if (colId === undefined) return { ok: false, reason: 'This sheet has no column with that name' }
  const reason = sheets.get(row.sheetId)?.readOnlyReason?.(row.rowId, colId)
  if (reason) return { ok: false, reason }
  return { ok: true, sheetId: row.sheetId, rowId: row.rowId, colId }
}

// ---- export ----

/** A CSV cell; text that a spreadsheet would run as a formula is prefixed with an apostrophe. */
function csvCell(value: unknown, type: ColumnType): string {
  let text = formatValue(value, type)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The report's rows as CSV (displayed columns only, in group order). */
export function reportToCsv(result: ReportResult): string {
  const lines = [result.columns.map((c) => csvCell(c.title, 'TEXT_NUMBER')).join(',')]
  for (const row of result.rows) lines.push(result.columns.map((c) => csvCell(row.values[c.key], c.type)).join(','))
  return lines.join('\r\n')
}

// ---- helpers for timelines ----

/** Picks the start, end and label columns a Gantt or timeline needs from a list of columns. */
export function pickTimeColumns(columns: readonly Pick<ResolvedColumn, 'key' | 'title' | 'type' | 'virtual'>[]): {
  label: string | null
  start: string | null
  end: string | null
} {
  const dates = columns.filter((c) => c.type === 'DATE')
  const start = dates.find((c) => /start|begin|from/i.test(c.title)) ?? dates[0] ?? null
  const rest = dates.filter((c) => c !== start)
  const end = rest.find((c) => /end|finish|due|until/i.test(c.title)) ?? rest[0] ?? null
  const label =
    columns.find((c) => !c.virtual && (c.type === 'TEXT_NUMBER' || c.type === 'PICKLIST') && /task|name|title|item|description/i.test(c.title)) ??
    columns.find((c) => !c.virtual && c.type === 'TEXT_NUMBER') ??
    null
  return { label: label?.key ?? null, start: start?.key ?? null, end: end?.key ?? null }
}
