/** Validation of the POST /api/planner/draft and /draft-batch bodies. */
import { MAX_BATCH_ITEMS, type BatchPlanItem, type BatchPlanRequest, type PlanRequest } from '../src/planner/types'

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

export type BatchParseResult = { ok: true; value: BatchPlanRequest } | { ok: false; error: string }

/** Checks the shape of a batch request: shared schedule type and notes, and 1 to MAX_BATCH_ITEMS items. */
export function parseBatchRequest(body: unknown): BatchParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'The request body must be a JSON object.' }
  const b = body as Record<string, unknown>
  const scheduleType = field(b, 'scheduleType', true)
  const notes = field(b, 'notes', false)
  for (const v of [scheduleType, notes]) if (v instanceof Error) return { ok: false, error: v.message }
  if (!Array.isArray(b.items) || b.items.length === 0) return { ok: false, error: 'items must be a list of at least one item.' }
  if (b.items.length > MAX_BATCH_ITEMS) return { ok: false, error: `items must have at most ${MAX_BATCH_ITEMS} entries.` }
  const items: BatchPlanItem[] = []
  for (const [i, raw] of b.items.entries()) {
    const where = `items[${i}]`
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: `${where} must be an object.` }
    const it = raw as Record<string, unknown>
    const equipmentType = field(it, 'equipmentType', true)
    const equipmentName = field(it, 'equipmentName', true)
    const itemNotes = field(it, 'notes', false)
    for (const v of [equipmentType, equipmentName, itemNotes]) if (v instanceof Error) return { ok: false, error: `${where}: ${v.message}` }
    if (typeof it.requiredDate !== 'string' || !isIsoDate(it.requiredDate)) {
      return { ok: false, error: `${where}: requiredDate must be a calendar date written YYYY-MM-DD.` }
    }
    const item: BatchPlanItem = {
      equipmentType: equipmentType as string,
      equipmentName: equipmentName as string,
      requiredDate: it.requiredDate,
    }
    if (itemNotes !== undefined) item.notes = itemNotes as string
    items.push(item)
  }
  const value: BatchPlanRequest = { scheduleType: scheduleType as string, items }
  if (notes !== undefined) value.notes = notes as string
  return { ok: true, value }
}

/** The single-item request the planner drafts for one batch item: the shared notes, then the item's own. */
export function planRequestFor(batch: BatchPlanRequest, item: BatchPlanItem): PlanRequest {
  const notes = [batch.notes, item.notes].filter(Boolean).join('\n')
  return {
    scheduleType: batch.scheduleType,
    equipmentType: item.equipmentType,
    equipmentName: item.equipmentName,
    requiredDate: item.requiredDate,
    ...(notes ? { notes } : {}),
  }
}
