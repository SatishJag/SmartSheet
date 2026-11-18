import type { AppTemplate, PlanPhase, PlanTask } from '../apps/types'
import type { PlanActivity, ProcStage, ProcurementPlan } from './types'

/** The plan's phases, in order, with the stages that fall in each. */
const PHASES: { name: string; stages: readonly ProcStage[] }[] = [
  { name: 'Kickoff and vendor documents', stages: ['Kickoff', 'Submittals', 'Approval'] },
  { name: 'Manufacturing and factory testing', stages: ['Manufacturing', 'FAT preparation', 'FAT', 'FAT closeout'] },
  {
    name: 'Shipping and delivery',
    stages: ['Freight planning', 'Shipping documents', 'Delivery planning', 'Dispatch', 'Transit', 'Customs', 'Local handling', 'Receipt'],
  },
  { name: 'Handover and site acceptance', stages: ['Handover', 'Site interface', 'SAT preparation', 'SAT', 'SAT closeout'] },
]

/** Parties outside the project team: they do the work but are not booked as resources. */
const EXTERNAL_OWNERS = new Set(['Supplier'])

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

/** Phases and tasks for the app builder, with the plan's own logic as explicit predecessors. */
export function planPhases(plan: ProcurementPlan): PlanPhase[] {
  if (plan.missing.length > 0) {
    throw new Error(`${plan.missing.length} activities still need a duration: ${plan.missing.join(', ')}`)
  }
  const phases: PlanPhase[] = []
  for (const phase of PHASES) {
    const tasks: PlanTask[] = plan.activities
      .filter((a) => a.included && phase.stages.includes(a.stage))
      .map((a) => ({
        name: a.name,
        days: a.duration ?? 0,
        discipline: plan.type.discipline,
        ...(EXTERNAL_OWNERS.has(a.owner) ? {} : { role: a.owner }),
        key: a.code,
        after: includedPredecessors(plan, a),
      }))
    if (tasks.length > 0) phases.push({ name: phase.name, tasks })
  }
  const placed = phases.reduce((n, p) => n + p.tasks.length, 0)
  if (placed !== plan.activities.filter((a) => a.included).length) throw new Error('Some activities belong to no phase')
  return phases
}

/**
 * An app template for the plan, so `buildApp` can turn it into a scheduled sheet. The sheet
 * starts on `plan.startBy`; the Gantt then shows the receipt on the need date and any slack on
 * the branches that do not drive it.
 */
export function planTemplate(plan: ProcurementPlan): AppTemplate {
  const phases = planPhases(plan)
  const roles = [...new Set(phases.flatMap((p) => p.tasks.map((t) => t.role).filter((r): r is string => !!r)))]
  return {
    id: `procurement-${plan.type.code.toLowerCase()}`,
    name: `${plan.type.name} procurement`,
    tagline: `${plan.type.name} from kickoff to site acceptance, worked back from ${plan.requiredOnSite}.`,
    about: [`Procurement plan for ${plan.type.name}, worked back from the date site needs it.`],
    roles,
    disciplines: [plan.type.discipline],
    plan: phases,
    supportSheets: [],
    illustration: 'datacenter',
  }
}
