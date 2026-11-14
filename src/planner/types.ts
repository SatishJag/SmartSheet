/**
 * The contract between the AI planner's three parts: the history database (supabase/migrations/
 * 0004_planner_history.sql), the planning server (server/) and the client (src/planner, the
 * "Plan with AI" wizard). Pure types, shared by all three.
 */
import type { DepType } from '../engine/types'

/** A kind of schedule the planner can draft, e.g. 'lle-procurement'. */
export interface ScheduleType {
  id: string
  name: string
  description: string
}

/** One step every schedule of a type may contain, with its usual place in the sequence. */
export interface CatalogActivity {
  scheduleType: string
  /** Stable code, unique within the schedule type, e.g. 'FAB' for fabrication. */
  code: string
  name: string
  phase: string
  /** Order within the type's standard sequence (1-based). */
  sequence: number
  /** The usual predecessors in a standard plan. */
  defaultLinks: { from: string; type: DepType; lagDays: number }[]
  /** Duration in working days used when history has no data for this activity. */
  defaultDays: number
  /** Marks the activity whose finish is the date the user asks for (e.g. 'On site'). */
  isTarget: boolean
}

/** Duration statistics for one activity, from completed historical projects. Working days. */
export interface ActivityStats {
  code: string
  /** Number of historical projects with an actual duration for this activity. */
  n: number
  p50: number
  p80: number
  min: number
  max: number
}

/** What the planner needs to know about one equipment type's history. */
export interface HistorySummary {
  scheduleType: string
  /** Null summarizes every equipment type of the schedule type. */
  equipmentType: string | null
  projectCount: number
  /** True when every project behind these numbers is seed sample data, not real history. */
  sampleOnly: boolean
  stats: ActivityStats[]
}

/** The planner's request, as the user enters it in the wizard. */
export interface PlanRequest {
  scheduleType: string
  /** e.g. 'Power transformer'; matches history_projects.equipment_type. */
  equipmentType: string
  /** Free text: '400 MVA transformer for substation B'. */
  equipmentName: string
  /** ISO date YYYY-MM-DD the equipment must be on site (the target activity's finish). */
  requiredDate: string
  /** Optional instructions or context: vendor, region, constraints, "use conservative durations". */
  notes?: string
}

export type DurationBasis = 'p50' | 'p80' | 'default' | 'adjusted'

export interface DraftActivity {
  code: string
  name: string
  phase: string
  durationDays: number
  /** Where the duration came from. 'adjusted' means the AI changed a historical figure. */
  basis: DurationBasis
  /** One short sentence: why this duration (cites the statistic used). */
  reason: string
}

export interface DraftLink {
  from: string
  to: string
  type: DepType
  lagDays: number
}

/** A first-cut plan: activities and logic only. Dates are computed by the client's engine. */
export interface PlanDraft {
  request: PlanRequest
  activities: DraftActivity[]
  links: DraftLink[]
  /** Code of the activity whose finish must land on request.requiredDate. */
  targetCode: string
  summary: string
  assumptions: string[]
  risks: string[]
  /** 'ai' when an LLM drafted it; 'history' when the server fell back to the catalog plus statistics. */
  source: 'ai' | 'history'
  /** The history the draft was based on (shown to the planner for trust). */
  history: HistorySummary
}

/** POST /api/planner/draft body and responses. Auth: `Authorization: Bearer <Supabase access token>`. */
export type DraftResponse = { ok: true; draft: PlanDraft } | { ok: false; error: string }

/** GET /api/planner/options: what the wizard offers. */
export interface PlannerOptions {
  scheduleTypes: ScheduleType[]
  /** Equipment types with history, per schedule type id. */
  equipmentTypes: Record<string, string[]>
}

/**
 * Read access to the planner's history. The server builds one per request from a Supabase client
 * that carries the user's token, so row-level security applies. Implemented by
 * `createSupabaseHistorySource` in src/planner/history.ts.
 */
export interface HistorySource {
  options(): Promise<PlannerOptions>
  catalog(scheduleType: string): Promise<CatalogActivity[]>
  /** equipmentType null: statistics over every equipment type of the schedule type. */
  summary(scheduleType: string, equipmentType: string | null): Promise<HistorySummary>
}
