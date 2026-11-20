import { anchorOf } from './backSchedule'
import { procurementType } from './catalog'
import type { ProcurementType } from './types'

/**
 * The database side of the procurement schedules. The database is the master: the planner drafts from
 * `activity_catalog`, and history is keyed to its codes. For the schedule types that come from the
 * procurement catalogue (materials, other equipment, subcontract, consultant) the module is the
 * source of the activities and their logic, and migration 0013 is generated from it:
 *
 *   npm run gen:schedule-types           write supabase/migrations/0013_more_schedule_types.sql
 *   npm run gen:schedule-types -- --check  exit 1 if the committed migration is out of date
 *
 * A test (src/db/scheduleTypesSync.test.ts) runs the same check, so the two cannot drift apart.
 * Changing a schedule type that was already deployed takes a NEW migration; the generator only
 * ever writes the one it owns.
 *
 * The long-lead equipment schedule type (0005, 0012) is not generated: its sample history is keyed
 * to its codes. The same test checks that its logic agrees with the module's equipment chains.
 */
export interface ScheduleTypeSpec {
  /** schedule_types.id */
  id: string
  /** The procurement type it comes from (src/procurement/starters.ts). */
  moduleCode: string
  name: string
  description: string
  /** The order the wizard lists schedule types in. */
  position: number
  /** The project types that offer it. */
  projectTypes: string[]
  /** The wizard's words for what it plans (schedule_types.item_labels, set by migration 0014). */
  itemLabels: { noun: string; typeExample: string; nameExample: string }
  /**
   * PLACEHOLDER default durations in working days, by step code (the part of the activity code after
   * the type): the Procurement app leaves durations open, and the planner needs a default per step.
   */
  defaultDays: Record<string, number>
}

const PLACEHOLDER_NOTE = ' Default durations are placeholders until you load your own history.'

export const GENERATED_SCHEDULE_TYPES: ScheduleTypeSpec[] = [
  {
    id: 'materials-procurement',
    moduleCode: 'MAT',
    name: 'Materials procurement',
    description: 'Concrete, rebar, cable and other bulk materials: requirement, quotations, award, supply and receipt.',
    position: 1,
    projectTypes: ['properties'],
    itemLabels: { noun: 'material', typeExample: 'Reinforcing steel', nameExample: '16 mm rebar for the level 3 slab' },
    defaultDays: { define_requirement: 5, rfq: 10, evaluate: 5, award: 3, source: 30, transport: 10, receive_inspect: 2 },
  },
  {
    id: 'other-equipment-procurement',
    moduleCode: 'OEQ',
    name: 'Other equipment procurement',
    description: 'Equipment outside the standard long-lead list: specification, tender, award, vendor drawings, manufacture, testing, shipping and receipt.',
    position: 3,
    projectTypes: ['data-centre'],
    itemLabels: { noun: 'equipment', typeExample: 'Cooling skid', nameExample: 'Modular cooling skid for data hall 2' },
    defaultDays: { define_specification: 15, tender: 30, evaluate: 10, award: 5, vendor_drawings: 20, release: 5, manufacture: 90, fat: 5, ship: 25, customs: 5, receive_accept: 2 },
  },
  {
    id: 'subcontract-procurement',
    moduleCode: 'SUB',
    name: 'Subcontract procurement',
    description: 'Subcontract packages: scope, tender, award, submissions, mobilisation and readiness.',
    position: 4,
    projectTypes: ['data-centre', 'properties'],
    itemLabels: { noun: 'subcontract package', typeExample: 'Raised floor', nameExample: 'Raised access floor for data hall 2' },
    defaultDays: { define_scope: 10, prequalify: 10, tender: 20, evaluate: 5, negotiate: 5, award: 3, approve_submissions: 10, mobilise: 10, confirm_readiness: 2 },
  },
  {
    id: 'consultant-appointment',
    moduleCode: 'CON',
    name: 'Consultant appointment',
    description: 'Consultants: brief, proposals, appointment, onboarding and start of service.',
    position: 5,
    projectTypes: ['data-centre', 'properties'],
    itemLabels: { noun: 'consultant', typeExample: 'Commissioning agent', nameExample: 'Commissioning agent for data hall 1' },
    defaultDays: { define_brief: 5, request_proposals: 15, evaluate: 5, negotiate: 5, appoint: 3, onboard: 5, commence: 1 },
  },
]

/** One row of activity_catalog, as the migration inserts it. */
export interface CatalogRow {
  scheduleType: string
  code: string
  name: string
  phase: string
  sequence: number
  defaultLinks: { from: string; type: 'FS'; lagDays: 0 }[]
  defaultDays: number
  isTarget: boolean
}

/** The database code of an activity: its code in the module without the type, upper-cased (`MAT.rfq` -> `RFQ`). */
export const dbCode = (type: ProcurementType, activityCode: string): string => activityCode.slice(type.code.length + 1).toUpperCase()

/** The activity_catalog rows of a generated schedule type, from the module's activities and logic. */
export function catalogRows(spec: ScheduleTypeSpec): CatalogRow[] {
  const type = procurementType(spec.moduleCode)
  if (!type) throw new Error(`No procurement type ${spec.moduleCode}`)
  const target = anchorOf(type)
  return type.activities.map((a, i) => {
    const suffix = a.code.slice(type.code.length + 1)
    const days = spec.defaultDays[suffix]
    if (days === undefined) throw new Error(`${spec.id}: no default duration for ${suffix}`)
    if (!a.phase) throw new Error(`${spec.id}: ${a.code} has no phase`)
    return {
      scheduleType: spec.id,
      code: dbCode(type, a.code),
      name: a.name,
      phase: a.phase,
      sequence: i + 1,
      defaultLinks: a.predecessors.map((p) => ({ from: dbCode(type, p), type: 'FS' as const, lagDays: 0 as const })),
      defaultDays: days,
      isTarget: a.code === target,
    }
  })
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`

const HEADER = `-- More schedule types for "Plan with AI", and which project types offer them.
--
-- Until now there was one schedule type (LLE procurement) under both project types, so switching
-- the project type changed nothing. The types below come from the Procurement schedule app's stage
-- lists (materials, other equipment, subcontract, consultant) with their logic; the Procurement
-- app leaves every duration open on purpose.
--
--   Data centre : Long-lead equipment, Other equipment, Subcontract, Consultant
--   Properties  : Materials, Long-lead equipment, Subcontract, Consultant
--
-- PLACEHOLDER DEFAULTS, NOT REAL HISTORY: every default_days below is a representative figure in
-- working days so that the planner can draft a first cut. Replace them, or load completed projects
-- into history_projects (the planner prefers history over these defaults, and tells the user when
-- an activity falls back to a default). The descriptions say so, too, where the user picks the type.
--
-- Each type is a chain, as in the source, so every activity is on its critical path; the long-lead
-- equipment type (0012) is the one with parallel work.

alter table schedule_types add column position integer not null default 0;

-- The order the wizard lists them in, and so which one a project type opens on.
update schedule_types set position = 2 where id = 'lle-procurement';

`

/** The text of supabase/migrations/0013_more_schedule_types.sql. */
export function migration0013Sql(): string {
  const types = GENERATED_SCHEDULE_TYPES.map(
    (s) => `  (${q(s.id)}, ${q(s.name)}, ${q(s.description + PLACEHOLDER_NOTE)}, ${s.position}, '{${s.projectTypes.join(',')}}')`,
  )
  const rows = GENERATED_SCHEDULE_TYPES.flatMap(catalogRows).map(
    (r) =>
      `  (${q(r.scheduleType)}, ${q(r.code)}, ${q(r.name)}, ${q(r.phase)}, ${r.sequence}, ${q(JSON.stringify(r.defaultLinks))}, ${r.defaultDays}, ${r.isTarget})`,
  )
  return (
    HEADER +
    'insert into schedule_types (id, name, description, position, project_types) values\n' +
    types.join(',\n') +
    ';\n\n' +
    'insert into activity_catalog (schedule_type, code, name, phase, sequence, default_links, default_days, is_target) values\n' +
    rows.join(',\n') +
    ';\n'
  )
}
