import type { DraftActivity, DraftLink, DurationBasis as DraftBasis, HistorySummary, PlanDraft, PlanRequest } from '../planner/types'
import { workingLength } from './backSchedule'
import type { DurationBasis, PlanActivity, ProcurementPlan } from './types'

/** The phases of an equipment plan, by the stages that fall in each. */
const EQUIPMENT_PHASES: { name: string; stages: readonly string[] }[] = [
  { name: 'Kickoff and vendor documents', stages: ['Kickoff', 'Submittals', 'Approval'] },
  { name: 'Manufacturing and factory testing', stages: ['Manufacturing', 'FAT preparation', 'FAT', 'FAT closeout'] },
  {
    name: 'Shipping and delivery',
    stages: ['Freight planning', 'Shipping documents', 'Delivery planning', 'Dispatch', 'Transit', 'Customs', 'Local handling', 'Receipt'],
  },
  { name: 'Handover and site acceptance', stages: ['Handover', 'Site interface', 'SAT preparation', 'SAT', 'SAT closeout'] },
]

/** How the planner's draft describes where a duration came from (it has no notion of earlier plans or templates). */
const BASIS: Record<DurationBasis, DraftBasis> = {
  history: 'p50',
  plans: 'default',
  similar: 'default',
  template: 'default',
  needed: 'default',
  edited: 'adjusted',
}

const REASON: Record<DurationBasis, (a: PlanActivity) => string> = {
  history: (a) => `Median of ${a.samples} completed ${a.samples === 1 ? 'activity' : 'activities'}.`,
  plans: (a) => `Median of ${a.samples} earlier approved ${a.samples === 1 ? 'plan' : 'plans'}.`,
  similar: (a) => `Median of ${a.samples} similar ${a.samples === 1 ? 'activity' : 'activities'} on other work.`,
  template: () => 'Template window; no history for this activity.',
  needed: () => 'No duration yet.',
  edited: () => 'Set by the planner.',
}

/**
 * Predecessors of an included activity, looking through any activity left out of the plan
 * (a left-out step passes its own predecessors on, so the logic stays connected).
 */
function includedPredecessors(plan: ProcurementPlan, a: PlanActivity): string[] {
  const by = new Map(plan.activities.map((x) => [x.code, x]))
  const out = new Set<string>()
  const walk = (codes: readonly string[]) => {
    for (const c of codes) {
      const p = by.get(c)
      if (!p) continue
      if (p.included) out.add(c)
      else walk(p.predecessors)
    }
  }
  walk(a.predecessors)
  return [...out]
}

export interface DraftOptions {
  equipmentType: string
  equipmentName: string
  notes?: string
}

/**
 * A procurement plan as the planner's draft, so it goes through the planner's own back-scheduling
 * (`planBackward`) and sheet builder (`buildSheetFromDraft`). The target is the activity that brings
 * the goods to site, so the plan's need date is the target's finish.
 *
 * Throws while a duration is missing, as there is nothing to schedule it by.
 */
export function planToDraft(plan: ProcurementPlan, opts: DraftOptions): PlanDraft {
  if (plan.missing.length > 0) {
    throw new Error(`${plan.missing.length} activities still need a duration: ${plan.missing.join(', ')}`)
  }
  const included = plan.activities.filter((a) => a.included)
  const phaseOf = (a: PlanActivity): string => {
    const name = a.phase ?? EQUIPMENT_PHASES.find((p) => p.stages.includes(a.stage))?.name
    if (!name) throw new Error(`Activity ${a.code} (${a.stage}) belongs to no phase`)
    return name
  }
  const activities: DraftActivity[] = included.map((a) => ({
    code: a.code,
    name: a.name,
    phase: phaseOf(a),
    // Working days: an elapsed step is converted at five per seven, as the back-scheduler does.
    durationDays: workingLength(a),
    basis: BASIS[a.basis],
    reason: REASON[a.basis](a),
  }))
  const links: DraftLink[] = included.flatMap((a) =>
    includedPredecessors(plan, a).map((from): DraftLink => ({ from, to: a.code, type: 'FS', lagDays: 0 })),
  )
  const target = included.find((a) => a.anchor)
  if (!target) throw new Error('The plan has no activity that brings the goods to site')
  const request: PlanRequest = {
    scheduleType: plan.type.code,
    equipmentType: opts.equipmentType,
    equipmentName: opts.equipmentName,
    requiredDate: plan.requiredOnSite,
    ...(opts.notes ? { notes: opts.notes } : {}),
  }
  const history: HistorySummary = { scheduleType: plan.type.code, equipmentType: null, projectCount: 0, sampleOnly: false, stats: [] }
  return {
    request,
    activities,
    links,
    targetCode: target.code,
    summary: `${plan.type.name} plan for ${opts.equipmentName}: ${included.length} steps, worked back from ${plan.requiredOnSite}.`,
    assumptions: ['Durations come from the procurement catalogue and any history supplied, not from this company’s own completed projects.'],
    risks: [],
    source: 'history',
    history,
  }
}
