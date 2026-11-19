// Durations for the schedule types that ship without any (calendar days for elapsed steps).
const GIVEN: Record<string, Record<string, number>> = {
  MAT: { define_requirement: 5, rfq: 10, evaluate: 5, award: 3, source: 60, transport: 21, receive_inspect: 2 },
  SUB: { define_scope: 5, prequalify: 10, tender: 28, evaluate: 7, negotiate: 5, award: 3, approve_submissions: 10, mobilise: 14, confirm_readiness: 2 },
  OEQ: { define_specification: 10, tender: 42, evaluate: 10, award: 3, vendor_drawings: 15, release: 2, manufacture: 180, fat: 5, ship: 35, customs: 7, receive_accept: 2 },
  CON: { define_brief: 3, request_proposals: 21, evaluate: 5, negotiate: 5, appoint: 2, onboard: 5, commence: 1 },
}
/** The durations above as plan overrides, keyed by activity code (`MAT.rfq`). */
export const given = (code: string) => Object.fromEntries(Object.entries(GIVEN[code]).map(([k, v]) => [`${code}.${k}`, v]))
