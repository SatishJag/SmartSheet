import type { ColumnType } from '../model/validate'

/** Shared types of the smart assets: workspaces, reports and dashboards. */

export type AssetType = 'sheet' | 'report' | 'dashboard'
/** What can be starred: assets, and the containers that hold them. */
export type FavoriteKind = AssetType | 'workspace' | 'folder'

export interface Workspace {
  id: string
  name: string
  createdAt: string
}

export interface Folder {
  id: string
  spaceId: string
  parentId: string | null
  name: string
  position: number
}

/** Where one asset lives. An asset without a placement is "not in a workspace". */
export interface Placement {
  id: string
  spaceId: string
  folderId: string | null
  assetType: AssetType
  assetId: string
  position: number
}

export interface Favorite {
  id: string
  kind: FavoriteKind
  targetId: string
}

// ---- source data (what the engines read; built from a loaded sheet, see sheetSource.ts) ----

export interface SourceColumn {
  id: string
  title: string
  type: ColumnType
  options?: string[]
}

/**
 * One sheet as the report and widget engines see it: plain values, no store. `value` returns what
 * the grid shows (scheduled dates and formula results included) as number | string | boolean | string[] | null.
 */
export interface SourceSheet {
  id: string
  name: string
  columns: SourceColumn[]
  /** Row ids in display (tree) order; a row's number is its index + 1. */
  rowIds: string[]
  value(rowId: string, colId: string): unknown
  /** True for a row with no data at all (reports skip those). */
  isBlankRow?(rowId: string): boolean
  /** Why a cell cannot be edited (null/undefined = it can). */
  readOnlyReason?(rowId: string, colId: string): string | null | undefined
  /** The text an editor starts with (a formula's source, not its value). */
  rawText?(rowId: string, colId: string): string
}

// ---- reports ----

/** A column of a report. Columns of different sheets with the same title are one report column. */
export interface ReportColumn {
  key: string
  title: string
}

export type FilterOp =
  | 'is'
  | 'isNot'
  | 'contains'
  | 'notContains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'blank'
  | 'notBlank'
  | 'lastDays'
  | 'nextDays'

/** `value` and `value2` are what the user typed: a number, a date (YYYY-MM-DD) or `today`, `today+7`, `today-3`. */
export interface Condition {
  column: string
  op: FilterOp
  value: string
  value2: string
}

export interface ReportFilter {
  match: 'all' | 'any'
  conditions: Condition[]
}

export type SummaryFn = 'sum' | 'avg' | 'count' | 'min' | 'max'

export interface ReportSort {
  column: string
  dir: 'asc' | 'desc'
}

export interface ReportSummary {
  column: string
  fn: SummaryFn
}

export interface ReportDefinition {
  /** Source sheet ids (1 to 10). */
  sources: string[]
  columns: ReportColumn[]
  filter: ReportFilter
  sort: ReportSort[]
  /** Up to two column keys. */
  groupBy: string[]
  summaries: ReportSummary[]
  /** Show the rows on a Gantt timeline too (needs a start and an end date column). */
  gantt: boolean
}

// ---- dashboards ----

export type SourceRef = { type: 'sheet' | 'report'; id: string }

export type MetricFn = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'percent'

export interface MetricConfig {
  source: SourceRef | null
  mode: 'summary' | 'cell'
  fn: MetricFn
  /** Column key of the source (a column id for a sheet, a report column key for a report). */
  column: string | null
  filter: ReportFilter
  /** Cell mode: the row (`sheetId:rowId` for a report, a row id for a sheet). */
  rowId: string | null
  /** `percent` shows the number with a % sign. */
  format: 'auto' | 'percent'
  prefix: string
  suffix: string
}

export type ChartKind = 'bar' | 'column' | 'line' | 'pie' | 'donut' | 'stacked'

export interface ChartConfig {
  source: SourceRef | null
  kind: ChartKind
  category: string | null
  value: string | null
  fn: 'count' | 'sum' | 'avg' | 'min' | 'max'
  /** Stacked charts: the column whose values become the segments. */
  stackBy: string | null
  filter: ReportFilter
  limit: number
  order: 'natural' | 'value'
}

/** Gantt grid and timeline widgets. */
export interface TimeConfig {
  source: SourceRef | null
  label: string | null
  start: string | null
  end: string | null
  filter: ReportFilter
  limit: number
}

export interface ShortcutLink {
  kind: AssetType | 'url'
  /** An asset id, or an https URL for `url`. */
  target: string
  label: string
}

interface WidgetBase {
  id: string
  x: number
  y: number
  w: number
  h: number
  title: string
}

export type Widget =
  | (WidgetBase & { type: 'title'; config: { text: string; size: 'large' | 'medium' } })
  | (WidgetBase & { type: 'text'; config: { text: string } })
  | (WidgetBase & { type: 'image'; config: { url: string; alt: string; link: string } })
  | (WidgetBase & { type: 'metric'; config: MetricConfig })
  | (WidgetBase & { type: 'chart'; config: ChartConfig })
  | (WidgetBase & { type: 'gantt'; config: TimeConfig })
  | (WidgetBase & { type: 'timeline'; config: TimeConfig })
  | (WidgetBase & { type: 'shortcut'; config: { links: ShortcutLink[] } })

export type WidgetType = Widget['type']

export interface DashboardLayout {
  widgets: Widget[]
}

export const GRID_COLUMNS = 12
export const MAX_SOURCES = 10
export const MAX_WIDGETS = 60

export interface ReportMeta {
  id: string
  name: string
  definition: ReportDefinition
  updatedAt: string
}

export interface DashboardMeta {
  id: string
  name: string
  layout: DashboardLayout
  updatedAt: string
}
