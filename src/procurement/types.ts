/** The stages of the long-lead equipment schedules (they key the default duration windows). */
export type ProcStage =
  | 'Kickoff'
  | 'Submittals'
  | 'Approval'
  | 'Manufacturing'
  | 'FAT preparation'
  | 'FAT'
  | 'FAT closeout'
  | 'Freight planning'
  | 'Shipping documents'
  | 'Delivery planning'
  | 'Dispatch'
  | 'Transit'
  | 'Customs'
  | 'Local handling'
  | 'Receipt'
  | 'Handover'
  | 'Site interface'
  | 'SAT preparation'
  | 'SAT'
  | 'SAT closeout'

/** One activity of a procurement schedule and its logic (all links are finish-to-start). */
export interface ProcActivity {
  /** Unique within its type, e.g. `CHL.9`. */
  code: string
  name: string
  /** What kind of work it is: a `ProcStage` for equipment, the step name for the other schedule types. */
  stage: string
  /** Who does it, as a role or party name (e.g. `Supplier`, `Logistics Coordinator`). */
  owner: string
  /** Codes of activities in the same type that must finish first. */
  predecessors: string[]
  /** Elapsed-time step (counts calendar days); converted to working days at five per seven. Default: working days. */
  elapsed?: boolean
  /** May be left out of a plan. */
  optional?: boolean
  /** The award (or appointment) step: its finish is when the order has to be placed. */
  award?: boolean
  /** The phase it is grouped under in a sheet. Equipment activities are grouped by stage instead. */
  phase?: string
  /** Role that has to approve this step before work moves on. */
  approver?: string
  /** What has to exist for the step to count as done (for example `Purchase order`). */
  evidence?: string[]
}

/** A kind of purchase with its activities and logic. */
export interface ProcurementType {
  code: string
  name: string
  /** Long-lead equipment has its own durations and stage windows; the others only give the stage list. */
  kind: 'equipment' | 'general'
  /** One line for a picker. */
  description?: string
  discipline: string
  /** The code this type has in the Procurement schedule app. */
  source: string
  /**
   * Code of the activity that brings the goods or service to site (it finishes on the need date).
   * Defaults to the last Receipt activity, else the last activity; set it for a type with no Receipt.
   */
  anchor?: string
  activities: ProcActivity[]
}

/** Where a duration came from, best evidence first. */
export type DurationBasis = 'history' | 'plans' | 'similar' | 'template' | 'needed' | 'edited'

export const BASIS_LABEL: Record<DurationBasis, string> = {
  history: 'History',
  plans: 'Earlier plans',
  similar: 'Similar work',
  template: 'Template',
  needed: 'Needs a duration',
  edited: 'Edited',
}

/** An activity inside a plan: the catalogue activity plus a duration, its source and its dates. */
export interface PlanActivity extends ProcActivity {
  /** Working days; null until someone supplies one. */
  duration: number | null
  basis: DurationBasis
  /** How many past durations the suggestion is based on. */
  samples: number
  included: boolean
  start: string
  finish: string
  /** The activity that brings the goods to site; it finishes on the need date. */
  anchor: boolean
  /** Scheduled forward from the anchor (handover, SAT) instead of back from the need date. */
  afterNeed: boolean
}

export interface ProcurementPlan {
  type: ProcurementType
  requiredOnSite: string
  /** The date procurement has to start to meet the need date. */
  startBy: string
  /** When the award has to be made, if the type has an award step; otherwise the start date. */
  awardBy: string
  /** The last finish in the plan (after handover and SAT). */
  finishOn: string
  activities: PlanActivity[]
  /** Codes of included activities that still need a duration (they take no time until given one). */
  missing: string[]
}
