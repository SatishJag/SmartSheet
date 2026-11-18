// The other schedule types from the Procurement schedule app (backend/app/workflow_templates.py):
// materials, subcontract and consultant. They give the stages and their logic only. The source
// leaves every duration open on purpose, because durations are project inputs, not market
// lead-time advice, so a plan from one of these needs a duration for each stage it includes.
// Activity codes are `<type>.<stage code>`.
import type { ProcurementType } from './types'

interface Row {
  code: string
  name: string
  owner: string
  after?: string[]
  /** Counts calendar days; converted to working days at five per seven. */
  elapsed?: true
  optional?: true
  award?: true
  approver?: string
  evidence?: string[]
  phase: string
}

const make = (
  code: string,
  name: string,
  description: string,
  source: string,
  anchor: string,
  rows: Row[],
): ProcurementType => ({
  code,
  name,
  kind: 'general',
  description,
  discipline: 'General',
  source,
  anchor: `${code}.${anchor}`,
  activities: rows.map(({ code: c, name: n, owner, after = [], elapsed, optional, award, approver, evidence, phase }) => ({
    code: `${code}.${c}`,
    name: n,
    stage: n,
    owner,
    predecessors: after.map((p) => `${code}.${p}`),
    phase,
    ...(elapsed ? { elapsed } : {}),
    ...(optional ? { optional } : {}),
    ...(award ? { award } : {}),
    ...(approver ? { approver } : {}),
    ...(evidence ? { evidence } : {}),
  }),
  ),
})

const MAT_TYPE = make("MAT", "Materials", "Materials such as concrete, rebar and cable: requirement, quotations, award, supply and receipt.", "materials", "receive_inspect", [
  { code: "define_requirement", name: "Define requirement", owner: "Planner", phase: "Requirement and sourcing" },
  { code: "rfq", name: "Request for quotation", owner: "Buyer", after: ["define_requirement"], phase: "Requirement and sourcing" },
  { code: "evaluate", name: "Evaluate quotations", owner: "Buyer", after: ["rfq"], evidence: ["Evaluation record"], phase: "Requirement and sourcing" },
  { code: "award", name: "Award", owner: "Procurement Manager", after: ["evaluate"], award: true, approver: "Procurement Manager", evidence: ["Purchase order"], phase: "Requirement and sourcing" },
  { code: "source", name: "Manufacture or source", owner: "Supplier", after: ["award"], elapsed: true, phase: "Supply" },
  { code: "transport", name: "Transport", owner: "Supplier", after: ["source"], elapsed: true, phase: "Supply" },
  { code: "receive_inspect", name: "Receive and inspect", owner: "Construction Manager", after: ["transport"], evidence: ["Receiving record"], phase: "Supply" },
])

const SUB_TYPE = make("SUB", "Subcontract", "Subcontract packages: scope, tender, award, submissions, mobilisation and readiness.", "subcontract", "confirm_readiness", [
  { code: "define_scope", name: "Define scope", owner: "Planner", phase: "Scope and tender" },
  { code: "prequalify", name: "Prequalify", owner: "Procurement Manager", after: ["define_scope"], optional: true, phase: "Scope and tender" },
  { code: "tender", name: "Tender", owner: "Buyer", after: ["prequalify"], elapsed: true, phase: "Scope and tender" },
  { code: "evaluate", name: "Evaluate", owner: "Buyer", after: ["tender"], phase: "Scope and tender" },
  { code: "negotiate", name: "Negotiate", owner: "Procurement Manager", after: ["evaluate"], optional: true, phase: "Scope and tender" },
  { code: "award", name: "Award", owner: "Procurement Manager", after: ["negotiate"], award: true, approver: "Project Manager", evidence: ["Subcontract"], phase: "Award and mobilisation" },
  { code: "approve_submissions", name: "Approve submissions", owner: "Design Reviewer", after: ["award"], evidence: ["Approved method statements"], phase: "Award and mobilisation" },
  { code: "mobilise", name: "Mobilise", owner: "Supplier", after: ["approve_submissions"], elapsed: true, phase: "Award and mobilisation" },
  { code: "confirm_readiness", name: "Confirm readiness", owner: "Construction Manager", after: ["mobilise"], approver: "Construction Manager", phase: "Award and mobilisation" },
])

const CON_TYPE = make("CON", "Consultant", "Consultant appointments: brief, proposals, appointment, onboarding and start of service.", "consultant", "commence", [
  { code: "define_brief", name: "Define brief", owner: "Project Manager", phase: "Brief and selection" },
  { code: "request_proposals", name: "Request proposals", owner: "Buyer", after: ["define_brief"], elapsed: true, phase: "Brief and selection" },
  { code: "evaluate", name: "Evaluate proposals", owner: "Buyer", after: ["request_proposals"], phase: "Brief and selection" },
  { code: "negotiate", name: "Negotiate", owner: "Procurement Manager", after: ["evaluate"], optional: true, phase: "Brief and selection" },
  { code: "appoint", name: "Appoint", owner: "Project Manager", after: ["negotiate"], award: true, approver: "Project Manager", evidence: ["Appointment"], phase: "Appointment" },
  { code: "onboard", name: "Onboard", owner: "Project Manager", after: ["appoint"], phase: "Appointment" },
  { code: "commence", name: "Commence service", owner: "Supplier", after: ["onboard"], phase: "Appointment" },
])

/** Materials, subcontract and consultant, in the order the Procurement app lists them. */
export const STARTER_TYPES: readonly ProcurementType[] = [
  MAT_TYPE,
  SUB_TYPE,
  CON_TYPE,
]
