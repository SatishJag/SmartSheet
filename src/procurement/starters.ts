// The other schedule types from the Procurement schedule app (backend/app/workflow_templates.py):
// materials, other equipment, subcontract and consultant. They give the stages and their logic only. The source
// leaves every duration open on purpose, because durations are project inputs, not market
// lead-time advice, so a plan from one of these needs a duration for each stage it includes.
// Activity codes are `<type>.<stage code>`.
import type { ProcurementType, ReleaseCondition } from './types'

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
  releaseConditions?: ReleaseCondition[]
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
  activities: rows.map(({ code: c, name: n, owner, after = [], elapsed, optional, award, approver, evidence, releaseConditions, phase }) => ({
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
    ...(releaseConditions ? { releaseConditions } : {}),
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

const OEQ_TYPE = make("OEQ", "Other equipment", "Equipment outside the eight long-lead types: specification, tender, award, vendor drawings, manufacture, testing, shipping and receipt.", "long_lead_equipment", "receive_accept", [
  { code: "define_specification", name: "Define specification", owner: "Design Reviewer", evidence: ["Specification"], phase: "Specification and tender" },
  { code: "tender", name: "Tender", owner: "Buyer", after: ["define_specification"], elapsed: true, phase: "Specification and tender" },
  { code: "evaluate", name: "Evaluate tenders", owner: "Buyer", after: ["tender"], evidence: ["Technical and commercial evaluation"], phase: "Specification and tender" },
  { code: "award", name: "Award", owner: "Procurement Manager", after: ["evaluate"], award: true, approver: "Procurement Manager", evidence: ["Award letter"], phase: "Specification and tender" },
  { code: "vendor_drawings", name: "Vendor drawing approval", owner: "Design Reviewer", after: ["award"], evidence: ["Approved drawings"], phase: "Design and manufacture" },
  { code: "release", name: "Release for manufacture", owner: "Procurement Manager", after: ["vendor_drawings"], releaseConditions: [
      { code: "effective_award", label: "Award is effective", mandatory: true },
      { code: "drawings_approved", label: "Drawings approved", mandatory: true },
      { code: "deposit_confirmed", label: "Deposit confirmed", mandatory: true },
      { code: "design_freeze", label: "Design freeze", mandatory: false },
      { code: "vendor_acknowledgement", label: "Vendor acknowledgement", mandatory: true },
    ], phase: "Design and manufacture" },
  { code: "manufacture", name: "Manufacture", owner: "Supplier", after: ["release"], elapsed: true, phase: "Design and manufacture" },
  { code: "fat", name: "Factory acceptance test", owner: "Quality Lead", after: ["manufacture"], optional: true, approver: "Quality Lead", evidence: ["FAT report"], phase: "Design and manufacture" },
  { code: "ship", name: "Ship", owner: "Supplier", after: ["fat"], elapsed: true, phase: "Delivery" },
  { code: "customs", name: "Customs", owner: "Buyer", after: ["ship"], elapsed: true, optional: true, phase: "Delivery" },
  { code: "receive_accept", name: "Receive and accept", owner: "Construction Manager", after: ["customs"], evidence: ["Receiving inspection"], phase: "Delivery" },
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

/** Materials, other equipment, subcontract and consultant, in the order the Procurement app lists them. */
export const STARTER_TYPES: readonly ProcurementType[] = [
  MAT_TYPE,
  OEQ_TYPE,
  SUB_TYPE,
  CON_TYPE,
]
