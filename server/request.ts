/** Validation of the POST /api/planner/draft body. */
import type { PlanRequest } from '../src/planner/types'

export const LIMITS = {
  scheduleType: 64,
  equipmentType: 100,
  equipmentName: 200,
  notes: 2000,
} as const

export type ParseResult = { ok: true; value: PlanRequest } | { ok: false; error: string }

const CONTROL = /[\u0000-\u001f\u007f]/
/** Notes may span lines: tab, line feed and carriage return are allowed there. */
const CONTROL_IN_NOTES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

function field(body: Record<string, unknown>, key: keyof typeof LIMITS, required: boolean): string | undefined | Error {
  const v = body[key]
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '' && !required)) {
    return required ? new Error(`${key} is required.`) : undefined
  }
  if (typeof v !== 'string') return new Error(`${key} must be a string.`)
  const t = v.trim()
  if (t === '') return new Error(`${key} is required.`)
  if (t.length > LIMITS[key]) return new Error(`${key} must be at most ${LIMITS[key]} characters.`)
  if ((key === 'notes' ? CONTROL_IN_NOTES : CONTROL).test(t)) return new Error(`${key} contains control characters.`)
  return t
}

/** True for a real calendar date written YYYY-MM-DD, between 2000 and 2100. */
export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y < 2000 || y > 2100) return false
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

/** Checks the shape of a draft request. Whether the schedule type exists is checked against the history. */
export function parsePlanRequest(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'The request body must be a JSON object.' }
  const b = body as Record<string, unknown>
  const scheduleType = field(b, 'scheduleType', true)
  const equipmentType = field(b, 'equipmentType', true)
  const equipmentName = field(b, 'equipmentName', true)
  const notes = field(b, 'notes', false)
  for (const v of [scheduleType, equipmentType, equipmentName, notes]) if (v instanceof Error) return { ok: false, error: v.message }
  if (typeof b.requiredDate !== 'string' || !isIsoDate(b.requiredDate)) {
    return { ok: false, error: 'requiredDate must be a calendar date written YYYY-MM-DD.' }
  }
  const value: PlanRequest = {
    scheduleType: scheduleType as string,
    equipmentType: equipmentType as string,
    equipmentName: equipmentName as string,
    requiredDate: b.requiredDate,
  }
  if (notes !== undefined) value.notes = notes as string
  return { ok: true, value }
}
