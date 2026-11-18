/** The stages an equipment activity can belong to (they key the default duration windows). */
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
  stage: ProcStage
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
}

export interface EquipmentType {
  code: string
  name: string
  discipline: string
  /** The code this type has in the Procurement schedule app. */
  source: string
  /**
   * Code of the activity that brings the goods to site (it finishes on the need date). Defaults
   * to the last Receipt activity; set it for a type that has none.
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
  type: EquipmentType
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
