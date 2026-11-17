import type { ColumnSpec } from '../templates/projectSchedule'

/** One task of a plan. By default it starts after the previous task (finish-to-start). */
export interface PlanTask {
  name: string
  /** Working days; 0 makes a milestone. */
  days: number
  /** Discipline / trade picklist value. */
  discipline?: string
  /** Resource role that does the work (becomes a placeholder person in Resource Management). */
  role?: string
  /** Start alongside the previous task (same predecessors) instead of after it. */
  parallel?: boolean
}

export interface PlanPhase {
  name: string
  tasks: PlanTask[]
}

/** A supporting sheet: plain columns and some starter rows (values by column title). */
export interface SupportSheet {
  name: string
  columns: ColumnSpec[]
  rows: Record<string, string | number | boolean>[]
}

export interface AppTemplate {
  id: string
  name: string
  /** One line for the gallery card. */
  tagline: string
  /** Paragraphs for the "About this app template" panel. */
  about: string[]
  /** Roles people play in this kind of project. */
  roles: string[]
  disciplines: string[]
  plan: PlanPhase[]
  supportSheets: SupportSheet[]
  illustration: 'crane' | 'datacenter' | 'buildings' | 'fitout'
}
