import type { ColumnType } from '../model/validate'
import { compileFilter, summarize, type ReportResult } from './reportEngine'
import type { ChartConfig, MetricConfig, SourceSheet, TimeConfig } from './types'
import { compareKeys, compareWithBlanks, formatValue, isBlank, isIsoDate, sortKeyOf, toNumber, type SortKey } from './values'

/**
 * Data for dashboard widgets: one number, a chart series, timeline items. Everything works on a `Table`,
 * which is either a whole sheet (columns keyed by column id) or a report's result (columns keyed by the
 * report column key), so a widget treats both alike. Pure.
 */

export interface TableColumn {
  key: string
  title: string
  type: ColumnType
  options?: string[]
}

export interface TableRow {
  id: string
  values: Record<string, unknown>
}

export interface Table {
  columns: TableColumn[]
  rows: TableRow[]
}

export function tableFromSheet(sheet: SourceSheet): Table {
  const columns = sheet.columns.map((c) => ({ key: c.id, title: c.title, type: c.type, options: c.options }))
  const rows: TableRow[] = []
  for (const id of sheet.rowIds) {
    if (sheet.isBlankRow?.(id)) continue
    const values: Record<string, unknown> = {}
    for (const c of columns) values[c.key] = sheet.value(id, c.key)
    rows.push({ id, values })
  }
  return { columns, rows }
}

export function tableFromReport(result: ReportResult): Table {
  return {
    columns: result.columns.map((c) => ({ key: c.key, title: c.title, type: c.type, options: c.options })),
    rows: result.rows.map((r) => ({ id: r.id, values: r.values })),
  }
}

const typeMap = (t: Table) => new Map(t.columns.map((c) => [c.key, c]))

function filtered(table: Table, filter: MetricConfig['filter'], today: string): TableRow[] {
  if (filter.conditions.length === 0) return table.rows
  const test = compileFilter(filter, typeMap(table), today)
  return table.rows.filter((r) => test(r.values))
}

// ---- metric ----

export interface MetricResult {
  value: number | string | null
  /** The text to show, with prefix, suffix and thousands separators. */
  display: string
  /** Why there is no value, when there is none. */
  note?: string
}

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

export function formatMetric(value: number | string | null, cfg: Pick<MetricConfig, 'format' | 'prefix' | 'suffix'>): string {
  if (value === null) return '–'
  const body = typeof value === 'number' ? numberFormat.format(value) : value
  const pct = cfg.format === 'percent' && typeof value === 'number' ? '%' : ''
  return `${cfg.prefix}${body}${pct}${cfg.suffix}`
}

export function metricValue(table: Table, cfg: MetricConfig, today: string): MetricResult {
  const done = (value: number | string | null, note?: string): MetricResult => ({ value, display: formatMetric(value, cfg), note })
  if (cfg.mode === 'cell') {
    const col = cfg.column ? table.columns.find((c) => c.key === cfg.column) : undefined
    if (!col) return done(null, 'Choose a column.')
    const row = cfg.rowId ? table.rows.find((r) => r.id === cfg.rowId) : undefined
    if (!row) return done(null, cfg.rowId ? 'That row no longer exists.' : 'Choose a row.')
    const v = row.values[col.key]
    if (isBlank(v, col.type)) return done(null)
    return done(typeof v === 'number' ? v : formatValue(v, col.type))
  }
  const rows = filtered(table, cfg.filter, today)
  if (cfg.fn === 'percent') {
    if (table.rows.length === 0) return done(null, 'The source has no rows.')
    return done(Math.round((rows.length / table.rows.length) * 1000) / 10)
  }
  if (cfg.fn === 'count' && !cfg.column) return done(rows.length)
  const col = cfg.column ? table.columns.find((c) => c.key === cfg.column) : undefined
  if (!col) return done(null, cfg.column ? 'That column no longer exists.' : 'Choose a column.')
  return done(summarize(rows.map((r) => r.values[col.key]), cfg.fn, col.type))
}

// ---- charts ----

export interface ChartData {
  categories: string[]
  series: { name: string; values: number[] }[]
  /** Set when categories were cut off at the chart's limit. */
  note?: string
}

const BLANK = '(Blank)'
const MAX_STACKS = 8

/** A category label: dates fall into months (2026-11); everything else is its text. */
function categoryLabel(value: unknown, type: ColumnType): string {
  if (type === 'DATE' && isIsoDate(value)) return value.slice(0, 7)
  return formatValue(value, type).trim() || BLANK
}

function aggregate(values: unknown[], fn: ChartConfig['fn'], type?: ColumnType): number {
  const v = summarize(values, fn, type)
  return typeof v === 'number' ? v : (toNumber(v) ?? 0)
}

export function chartData(table: Table, cfg: ChartConfig, today: string): ChartData {
  const cat = cfg.category ? table.columns.find((c) => c.key === cfg.category) : undefined
  if (!cat) return { categories: [], series: [] }
  const val = cfg.value ? table.columns.find((c) => c.key === cfg.value) : undefined
  const stack = cfg.kind === 'stacked' && cfg.stackBy ? table.columns.find((c) => c.key === cfg.stackBy) : undefined
  const rows = filtered(table, cfg.filter, today)

  // category label -> stack label -> the value cells of its rows
  const cells = new Map<string, Map<string, unknown[]>>()
  const order = new Map<string, SortKey | null>()
  const stackTotals = new Map<string, number>()
  for (const row of rows) {
    const label = categoryLabel(row.values[cat.key], cat.type)
    const stackLabel = stack ? categoryLabel(row.values[stack.key], stack.type) : ''
    let byStack = cells.get(label)
    if (!byStack) {
      byStack = new Map()
      cells.set(label, byStack)
      order.set(label, label === BLANK ? null : cat.type === 'DATE' ? { k: 1, s: label } : sortKeyOf(row.values[cat.key], cat.type))
    }
    const list = byStack.get(stackLabel)
    const cell = val ? row.values[val.key] : 1
    if (list) list.push(cell)
    else byStack.set(stackLabel, [cell])
    if (stack) stackTotals.set(stackLabel, (stackTotals.get(stackLabel) ?? 0) + 1)
  }

  const fn = val ? cfg.fn : 'count'
  const valueOf = (list: unknown[] | undefined) => (list ? (val ? aggregate(list, fn, val.type) : list.length) : 0)

  // Series: one, or one per stack value (the biggest few; the rest are "Other").
  const stackNames = stack
    ? [...stackTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_STACKS).map(([name]) => name)
    : ['']
  const hasOther = stack ? stackTotals.size > stackNames.length : false
  const seriesNames = hasOther ? [...stackNames, 'Other'] : stackNames

  let categories = [...cells.keys()]
  const totalOf = (label: string) => {
    const byStack = cells.get(label)!
    return [...byStack.values()].reduce((n, list) => n + valueOf(list), 0)
  }
  let note: string | undefined
  if (cfg.order === 'value' || categories.length > cfg.limit) {
    categories.sort((a, b) => totalOf(b) - totalOf(a))
  }
  if (categories.length > cfg.limit) {
    note = `Showing the ${cfg.limit} largest of ${categories.length} values.`
    categories = categories.slice(0, cfg.limit)
  }
  if (cfg.order === 'natural') {
    categories.sort((a, b) => compareWithBlanks(order.get(a) ?? null, order.get(b) ?? null, 'asc'))
    const options = cat.options
    if (options && cat.type === 'PICKLIST') {
      const rank = (l: string) => (options.includes(l) ? options.indexOf(l) : l === BLANK ? options.length + 1 : options.length)
      categories.sort((a, b) => rank(a) - rank(b))
    }
  }

  const series = seriesNames.map((name) => ({
    name: name || (val ? `${FN_NAMES[fn]} of ${val.title}` : 'Count'),
    values: categories.map((label) => {
      const byStack = cells.get(label)!
      if (!stack) return valueOf(byStack.get(''))
      if (name === 'Other' && hasOther && !stackNames.includes('Other')) {
        const rest = [...byStack.entries()].filter(([s]) => !stackNames.includes(s)).flatMap(([, list]) => list)
        return rest.length > 0 ? valueOf(rest) : 0
      }
      return valueOf(byStack.get(name))
    }),
  }))
  return { categories, series, note }
}

const FN_NAMES = { count: 'Count', sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max' } as const

// ---- gantt and timeline ----

export interface TimeItem {
  id: string
  label: string
  start: string
  end: string
  /** No end date, or an end before the start: drawn as a point. */
  milestone: boolean
}

export interface TimeData {
  items: TimeItem[]
  min: string | null
  max: string | null
  /** Rows without a usable start date. */
  skipped: number
  note?: string
}

export function timeItems(table: Table, cfg: TimeConfig, today: string): TimeData {
  const start = cfg.start ? table.columns.find((c) => c.key === cfg.start) : undefined
  if (!start) return { items: [], min: null, max: null, skipped: 0 }
  const end = cfg.end ? table.columns.find((c) => c.key === cfg.end) : undefined
  const label = cfg.label ? table.columns.find((c) => c.key === cfg.label) : undefined
  const items: TimeItem[] = []
  let skipped = 0
  for (const row of filtered(table, cfg.filter, today)) {
    const s = row.values[start.key]
    if (!isIsoDate(s)) {
      skipped++
      continue
    }
    const e = end ? row.values[end.key] : null
    const hasEnd = isIsoDate(e) && e >= s
    items.push({
      id: row.id,
      label: (label ? formatValue(row.values[label.key], label.type).trim() : '') || '(No name)',
      start: s,
      end: hasEnd ? e : s,
      milestone: !hasEnd,
    })
  }
  items.sort((a, b) => compareKeys({ k: 1, s: a.start }, { k: 1, s: b.start }) || compareKeys({ k: 2, s: a.label }, { k: 2, s: b.label }))
  let note: string | undefined
  const cut = items.length > cfg.limit
  if (cut) note = `Showing the first ${cfg.limit} of ${items.length} items.`
  const shown = items.slice(0, cfg.limit)
  return {
    items: shown,
    min: shown.length ? shown.reduce((m, i) => (i.start < m ? i.start : m), shown[0].start) : null,
    max: shown.length ? shown.reduce((m, i) => (i.end > m ? i.end : m), shown[0].end) : null,
    skipped,
    note,
  }
}
