import {
  GRID_COLUMNS,
  MAX_SOURCES,
  MAX_WIDGETS,
  type ChartConfig,
  type ChartKind,
  type Condition,
  type DashboardLayout,
  type FilterOp,
  type MetricConfig,
  type MetricFn,
  type ReportDefinition,
  type ReportFilter,
  type ShortcutLink,
  type SourceRef,
  type SummaryFn,
  type TimeConfig,
  type Widget,
  type WidgetType,
} from './types'

/**
 * Shapes of the two json documents the database stores (`reports.definition`, `dashboards.layout`).
 * The database only checks "an object of sane size"; everything else is validated here. Parsing is
 * LENIENT: it keeps what is valid, repairs what it can and drops the rest, so a document written by
 * a newer or older version never crashes the page.
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max = 200, fallback = ''): string => (typeof v === 'string' ? v.slice(0, max) : fallback)
const bool = (v: unknown, fallback = false): boolean => (typeof v === 'boolean' ? v : fallback)
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback)
const int = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback
const keyOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, 200) : null)

export const FILTER_OPS: readonly FilterOp[] = [
  'is', 'isNot', 'contains', 'notContains', 'gt', 'gte', 'lt', 'lte', 'between', 'blank', 'notBlank', 'lastDays', 'nextDays',
]
export const SUMMARY_FNS: readonly SummaryFn[] = ['sum', 'avg', 'count', 'min', 'max']
const METRIC_FNS: readonly MetricFn[] = ['count', 'sum', 'avg', 'min', 'max', 'percent']
const CHART_KINDS: readonly ChartKind[] = ['bar', 'column', 'line', 'pie', 'donut', 'stacked']
const CHART_FNS = ['count', 'sum', 'avg', 'min', 'max'] as const

export const MAX_COLUMNS = 40
export const MAX_CONDITIONS = 20
export const MAX_SUMMARIES = 20

// ---- filters and reports ----

export const emptyFilter = (): ReportFilter => ({ match: 'all', conditions: [] })

export function parseFilter(json: unknown): ReportFilter {
  if (!isObj(json)) return emptyFilter()
  const conditions: Condition[] = []
  if (Array.isArray(json.conditions)) {
    for (const c of json.conditions.slice(0, MAX_CONDITIONS)) {
      if (!isObj(c) || typeof c.column !== 'string' || !FILTER_OPS.includes(c.op as FilterOp)) continue
      conditions.push({ column: c.column.slice(0, 200), op: c.op as FilterOp, value: str(c.value, 200), value2: str(c.value2, 200) })
    }
  }
  return { match: pick(json.match, ['all', 'any'], 'all'), conditions }
}

export function emptyReportDefinition(): ReportDefinition {
  return { sources: [], columns: [], filter: emptyFilter(), sort: [], groupBy: [], summaries: [], gantt: false }
}

export function parseReportDefinition(json: unknown): ReportDefinition {
  const def = emptyReportDefinition()
  if (!isObj(json)) return def
  if (Array.isArray(json.sources)) {
    def.sources = [...new Set(json.sources.filter((s): s is string => typeof s === 'string' && s !== ''))].slice(0, MAX_SOURCES)
  }
  if (Array.isArray(json.columns)) {
    const seen = new Set<string>()
    for (const c of json.columns.slice(0, MAX_COLUMNS)) {
      if (!isObj(c) || typeof c.key !== 'string' || seen.has(c.key)) continue
      seen.add(c.key)
      def.columns.push({ key: c.key.slice(0, 200), title: str(c.title, 100, c.key) })
    }
  }
  def.filter = parseFilter(json.filter)
  if (Array.isArray(json.sort)) {
    for (const s of json.sort.slice(0, 3)) {
      if (isObj(s) && typeof s.column === 'string') def.sort.push({ column: s.column, dir: pick(s.dir, ['asc', 'desc'], 'asc') })
    }
  }
  if (Array.isArray(json.groupBy)) def.groupBy = [...new Set(json.groupBy.filter((g): g is string => typeof g === 'string'))].slice(0, 2)
  if (Array.isArray(json.summaries)) {
    const seen = new Set<string>()
    for (const s of json.summaries.slice(0, MAX_SUMMARIES)) {
      if (!isObj(s) || typeof s.column !== 'string' || seen.has(s.column) || !SUMMARY_FNS.includes(s.fn as SummaryFn)) continue
      seen.add(s.column)
      def.summaries.push({ column: s.column, fn: s.fn as SummaryFn })
    }
  }
  def.gantt = bool(json.gantt)
  return def
}

/** Why a report cannot be saved or run yet (empty = fine). */
export function reportProblems(def: ReportDefinition): string[] {
  const problems: string[] = []
  if (def.sources.length === 0) problems.push('Choose at least one sheet to pull rows from.')
  if (def.sources.length > MAX_SOURCES) problems.push(`A report can use at most ${MAX_SOURCES} sheets.`)
  if (def.columns.length === 0) problems.push('Choose at least one column to show.')
  return problems
}

// ---- dashboards ----

export const emptyLayout = (): DashboardLayout => ({ widgets: [] })

const parseSource = (v: unknown): SourceRef | null =>
  isObj(v) && (v.type === 'sheet' || v.type === 'report') && typeof v.id === 'string' && v.id !== '' ? { type: v.type, id: v.id } : null

export function defaultMetric(): MetricConfig {
  return { source: null, mode: 'summary', fn: 'count', column: null, filter: emptyFilter(), rowId: null, format: 'auto', prefix: '', suffix: '' }
}
export function defaultChart(): ChartConfig {
  return { source: null, kind: 'column', category: null, value: null, fn: 'count', stackBy: null, filter: emptyFilter(), limit: 12, order: 'natural' }
}
export function defaultTime(): TimeConfig {
  return { source: null, label: null, start: null, end: null, filter: emptyFilter(), limit: 100 }
}

function parseMetric(c: Record<string, unknown>): MetricConfig {
  return {
    source: parseSource(c.source),
    mode: pick(c.mode, ['summary', 'cell'], 'summary'),
    fn: pick(c.fn, METRIC_FNS, 'count'),
    column: keyOrNull(c.column),
    filter: parseFilter(c.filter),
    rowId: keyOrNull(c.rowId),
    format: pick(c.format, ['auto', 'percent'], 'auto'),
    prefix: str(c.prefix, 12),
    suffix: str(c.suffix, 24),
  }
}

function parseChart(c: Record<string, unknown>): ChartConfig {
  return {
    source: parseSource(c.source),
    kind: pick(c.kind, CHART_KINDS, 'column'),
    category: keyOrNull(c.category),
    value: keyOrNull(c.value),
    fn: pick(c.fn, CHART_FNS, 'count'),
    stackBy: keyOrNull(c.stackBy),
    filter: parseFilter(c.filter),
    limit: int(c.limit, 2, 50, 12),
    order: pick(c.order, ['natural', 'value'], 'natural'),
  }
}

function parseTime(c: Record<string, unknown>): TimeConfig {
  return {
    source: parseSource(c.source),
    label: keyOrNull(c.label),
    start: keyOrNull(c.start),
    end: keyOrNull(c.end),
    filter: parseFilter(c.filter),
    limit: int(c.limit, 1, 300, 100),
  }
}

/** Only web links open from a widget: javascript: and data: URLs are dropped. */
export function safeUrl(v: unknown): string {
  if (typeof v !== 'string') return ''
  const t = v.trim().slice(0, 2000)
  try {
    const u = new URL(t)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''
  } catch {
    return ''
  }
}

function parseLinks(v: unknown): ShortcutLink[] {
  if (!Array.isArray(v)) return []
  const out: ShortcutLink[] = []
  for (const l of v.slice(0, 20)) {
    if (!isObj(l) || !['sheet', 'report', 'dashboard', 'url'].includes(l.kind as string)) continue
    const kind = l.kind as ShortcutLink['kind']
    const target = kind === 'url' ? safeUrl(l.target) : str(l.target, 64)
    if (target === '') continue
    out.push({ kind, target, label: str(l.label, 100) })
  }
  return out
}

/** Default size (grid columns x rows) of each widget type. */
export const WIDGET_SIZES: Record<WidgetType, { w: number; h: number }> = {
  title: { w: 12, h: 1 },
  text: { w: 4, h: 3 },
  image: { w: 4, h: 3 },
  metric: { w: 3, h: 2 },
  chart: { w: 6, h: 4 },
  gantt: { w: 12, h: 5 },
  timeline: { w: 12, h: 4 },
  shortcut: { w: 4, h: 3 },
}

export const WIDGET_TYPES = Object.keys(WIDGET_SIZES) as WidgetType[]

/** A widget with default settings at the given grid position. */
export function newWidget(type: WidgetType, id: string, x = 0, y = 0): Widget {
  const { w, h } = WIDGET_SIZES[type]
  const base = { id, x, y, w, h, title: '' }
  switch (type) {
    case 'title':
      return { ...base, type, title: 'Dashboard title', config: { text: '', size: 'large' } }
    case 'text':
      return { ...base, type, config: { text: '' } }
    case 'image':
      return { ...base, type, config: { url: '', alt: '', link: '' } }
    case 'metric':
      return { ...base, type, config: defaultMetric() }
    case 'chart':
      return { ...base, type, config: defaultChart() }
    case 'gantt':
      return { ...base, type, config: defaultTime() }
    case 'timeline':
      return { ...base, type, config: defaultTime() }
    case 'shortcut':
      return { ...base, type, config: { links: [] } }
  }
}

function parseWidget(raw: unknown, index: number, used: Set<string>): Widget | null {
  if (!isObj(raw) || !WIDGET_TYPES.includes(raw.type as WidgetType)) return null
  const type = raw.type as WidgetType
  let id = str(raw.id, 64) || `w${index + 1}`
  while (used.has(id)) id = `${id}_${index}`
  used.add(id)
  const size = WIDGET_SIZES[type]
  const w = int(raw.w, 1, GRID_COLUMNS, size.w)
  const base = {
    id,
    w,
    h: int(raw.h, 1, 40, size.h),
    x: int(raw.x, 0, GRID_COLUMNS - w, 0),
    y: int(raw.y, 0, 400, 0),
    title: str(raw.title, 100),
  }
  const c = isObj(raw.config) ? raw.config : {}
  switch (type) {
    case 'title':
      return { ...base, type, config: { text: str(c.text, 200), size: pick(c.size, ['large', 'medium'], 'large') } }
    case 'text':
      return { ...base, type, config: { text: str(c.text, 5000) } }
    case 'image':
      return { ...base, type, config: { url: safeUrl(c.url), alt: str(c.alt, 200), link: safeUrl(c.link) } }
    case 'metric':
      return { ...base, type, config: parseMetric(c) }
    case 'chart':
      return { ...base, type, config: parseChart(c) }
    case 'gantt':
      return { ...base, type, config: parseTime(c) }
    case 'timeline':
      return { ...base, type, config: parseTime(c) }
    case 'shortcut':
      return { ...base, type, config: { links: parseLinks(c.links) } }
  }
}

export function parseDashboardLayout(json: unknown): DashboardLayout {
  if (!isObj(json) || !Array.isArray(json.widgets)) return emptyLayout()
  const used = new Set<string>()
  const widgets: Widget[] = []
  json.widgets.slice(0, MAX_WIDGETS).forEach((raw, i) => {
    const w = parseWidget(raw, i, used)
    if (w) widgets.push(w)
  })
  return { widgets }
}

/** The report and sheet ids a dashboard reads from (to know what to load). */
export function layoutSources(layout: DashboardLayout): SourceRef[] {
  const seen = new Map<string, SourceRef>()
  for (const w of layout.widgets) {
    const source = 'source' in w.config ? w.config.source : null
    if (source) seen.set(`${source.type}:${source.id}`, source)
  }
  return [...seen.values()]
}
