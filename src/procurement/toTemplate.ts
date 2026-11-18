import type { AppTemplate, PlanPhase, PlanTask } from '../apps/types'
import { workingLength } from './backSchedule'
import type { PlanActivity, ProcurementPlan } from './types'

/** The equipment plan's phases, in order, with the stages that fall in each. */
const PHASES: { name: string; stages: readonly string[] }[] = [
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
  // An activity's phase is the one it names (materials, subcontract, consultant) or the one its stage belongs to.
  const phaseOf = (a: PlanActivity): string => {
    const name = a.phase ?? PHASES.find((p) => p.stages.includes(a.stage))?.name
    if (!name) throw new Error(`Activity ${a.code} (${a.stage}) belongs to no phase`)
    return name
  }
  const included = plan.activities.filter((a) => a.included)
  const order = [...PHASES.map((p) => p.name), ...included.map(phaseOf)]
  const names = [...new Set(order)].filter((n) => included.some((a) => phaseOf(a) === n))
  return names.map((name) => ({
    name,
    tasks: included
      .filter((a) => phaseOf(a) === name)
      .map((a): PlanTask => ({
        name: a.name,
        // Working days: an elapsed step is converted at five per seven, as the back-scheduler does.
        days: workingLength(a),
        discipline: plan.type.discipline,
        ...(EXTERNAL_OWNERS.has(a.owner) ? {} : { role: a.owner }),
        key: a.code,
        after: includedPredecessors(plan, a),
      })),
  }))
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
