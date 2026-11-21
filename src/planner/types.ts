/**
 * The contract between the AI planner's three parts: the history database (supabase/migrations/
 * 0004_planner_history.sql), the planning server (server/) and the client (src/planner, the
 * "Plan with AI" wizard). Pure types, shared by all three.
 */
import type { DepType } from '../engine/types'

/** The words the wizard uses for what is being planned (equipment, material, ...). */
export interface ItemLabels {
  /** Lower case, singular: 'equipment', 'material', 'subcontract package'. */
  noun: string
  /** An example type, shown as the placeholder of the type field. */
  typeExample: string
  /** An example name, shown as the placeholder of the name field. */
  nameExample: string
  /** The wizard's question on the request step. Default: "What do you need on site?" */
  heading?: string
  /** The sentence under it. Default: "Choose the <noun> and the date it must be on site. ..." */
  intro?: string
  /** The label of the date field. Default: "Required on site". */
  dateLabel?: string
}

/** Used when a schedule type gives none. */
export const DEFAULT_ITEM_LABELS: ItemLabels = {
  noun: 'equipment',
  typeExample: 'Gas turbine',
  nameExample: '400 MVA transformer for substation B',
}

/** A kind of schedule the planner can draft, e.g. 'lle-procurement'. */
export interface ScheduleType {
  id: string
  name: string
  description: string
  /** Ids of the project types this schedule type applies to. Absent or empty: offered under every project type. */
  projectTypes?: string[]
  /** What the schedule plans, in the wizard's words. Absent: equipment. */
  itemLabels?: ItemLabels
}

/** A kind of project the user plans first (Data centre, Properties); it narrows the schedule types on offer. */
export interface ProjectType {
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
  /** Optional reference details a template carries (shown as columns of the created sheet). */
  activityId?: string
  /** Lead responsibility, e.g. "Design / Consultant". */
  responsibility?: string
  /** Completion / release criteria of the activity or gate. */
  criteria?: string
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
  /** Copied from the catalog by the server when the catalog has them (see CatalogActivity). */
  activityId?: string
  responsibility?: string
  criteria?: string
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

// ---- Several equipment items in one plan (POST /api/planner/draft-batch) ----

/** The most items one batch request may carry. */
export const MAX_BATCH_ITEMS = 6

/** One piece of equipment in a batch: what a PlanRequest adds to the shared schedule type and notes. */
export interface BatchPlanItem {
  /** e.g. 'Power transformer'; matches history_projects.equipment_type. */
  equipmentType: string
  /** Free text: '400 MVA transformer, Substation B'. */
  equipmentName: string
  /** ISO date YYYY-MM-DD this item must be on site. */
  requiredDate: string
  /** Optional instructions for this item only; appended to the shared notes. */
  notes?: string
}

/** POST /api/planner/draft-batch body. Auth as for /draft. 1 to MAX_BATCH_ITEMS items. */
export interface BatchPlanRequest {
  scheduleType: string
  /** Shared by every item. */
  notes?: string
  items: BatchPlanItem[]
}

/** One item's outcome: a draft, or why that item could not be drafted (the others are unaffected). */
export type BatchItemResult = { ok: true; draft: PlanDraft } | { ok: false; error: string }

/**
 * The response: `results[i]` belongs to `items[i]`. A request-level problem (bad body, rate limit,
 * unknown schedule type) is `{ ok: false, error }` with a 4xx/5xx status and nothing is drafted.
 */
export type BatchDraftResponse = { ok: true; results: BatchItemResult[] } | { ok: false; error: string }

/** GET /api/planner/options: what the wizard offers. */
/**
 * A Procore cost code offered to the planner (cost_codes with in_planner; see
 * supabase/migrations/0019_cost_codes.sql). `equipmentType` is the planner equipment type whose items
 * get this code filled in automatically, or null.
 */
export interface CostCode {
  code: string
  description: string
  equipmentType: string | null
}

export interface PlannerOptions {
  /** Optional: when present the wizard asks for the project type first. */
  projectTypes?: ProjectType[]
  scheduleTypes: ScheduleType[]
  /** Equipment types with history, per schedule type id. */
  equipmentTypes: Record<string, string[]>
  /**
   * Optional: historical projects per equipment type, per schedule type id. The wizard shows the
   * count on its equipment cards ("Power transformer · 8 projects") when it is given. The Supabase
   * source does not fill it yet (the planner_equipment_types view has no count).
   */
  projectCounts?: Record<string, Record<string, number>>
  /**
   * Optional: the cost codes an item can be tagged with, by code. Absent when there are none or they
   * could not be read; the wizard then hides the Cost code field and the sheet gets no such column.
   */
  costCodes?: CostCode[]
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
