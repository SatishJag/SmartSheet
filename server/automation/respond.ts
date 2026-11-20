/**
 * What a person who opens an update link may change, and the checks on what they send. They get
 * ONLY the columns the sender chose; every value is validated like a typed cell, and a formula ("=...")
 * from the outside is never accepted (it would run inside the owner's sheet).
 */
import { validateCell, type Column } from '../../src/model/validate'
import { isFormulaCell } from './formulas'

export const REQUESTABLE_TYPES = ['TEXT_NUMBER', 'DATE', 'CHECKBOX', 'PICKLIST', 'MULTI_PICKLIST', 'CONTACT_LIST', 'DURATION'] as const
const SCHEDULE_ROLES = new Set(['start', 'end', 'duration'])
const MAX_VALUE_CHARS = 2000

export interface FieldView {
  id: string
  title: string
  type: string
  options?: string[]
  value: unknown
  /** False for a cell that holds a formula: shown (as its result is not known here) read-only, never changed. */
  editable: boolean
}

/** Why `col` cannot be offered in an update request, or null. */
export function requestableProblem(col: Column, ctx: { dependenciesEnabled: boolean; rowHasChildren: boolean }): string | null {
  if (!(REQUESTABLE_TYPES as readonly string[]).includes(col.type)) return `"${col.title}" cannot be edited through a link`
  if (col.role === 'predecessor') return `"${col.title}" cannot be edited through a link`
  if (ctx.dependenciesEnabled && col.role && SCHEDULE_ROLES.has(col.role)) return `"${col.title}" is set by the schedule while dependencies are on`
  if (ctx.rowHasChildren && col.role && (SCHEDULE_ROLES.has(col.role) || col.role === 'percentComplete')) return `"${col.title}" on a summary row is calculated from its sub-rows`
  return null
}

/** The requested columns with their current values, in the order requested; deleted columns are dropped. */
export function fieldsFor(columns: readonly Column[], columnIds: readonly string[], cells: Record<string, unknown>): FieldView[] {
  const out: FieldView[] = []
  for (const id of columnIds) {
    const col = columns.find((c) => c.id === id)
    if (!col) continue
    const value = cells[id] ?? (col.type === 'CHECKBOX' ? false : col.type === 'MULTI_PICKLIST' ? [] : null)
    const formula = isFormulaCell(cells[id])
    out.push({
      id,
      title: col.title,
      type: col.type,
      ...(col.options ? { options: col.options } : {}),
      value: formula ? null : value,
      editable: !formula,
    })
  }
  return out
}

export type ResponseCheck = { ok: true; patch: Record<string, unknown> } | { ok: false; error: string; fieldId?: string }

/** Validates what was sent against the requested columns; the patch holds the normalised values. */
export function validateResponse(
  columns: readonly Column[],
  requestedIds: readonly string[],
  cells: Record<string, unknown>,
  values: unknown,
  ctx: { hoursPerDay: number; dependenciesEnabled: boolean },
): ResponseCheck {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return { ok: false, error: 'Send the values as an object.' }
  const sent = values as Record<string, unknown>
  const keys = Object.keys(sent)
  if (keys.length === 0) return { ok: false, error: 'Change at least one value.' }
  const patch: Record<string, unknown> = {}
  for (const id of keys) {
    if (!requestedIds.includes(id)) return { ok: false, error: 'That field is not part of this request.', fieldId: id }
    const col = columns.find((c) => c.id === id)
    if (!col) return { ok: false, error: 'That field no longer exists.', fieldId: id }
    if (isFormulaCell(cells[id])) return { ok: false, error: `"${col.title}" is calculated and cannot be changed.`, fieldId: id }
    const raw = toRaw(sent[id])
    if (raw === null) return { ok: false, error: `"${col.title}": send text, a number, a checkbox value or a list.`, fieldId: id }
    if (raw.length > MAX_VALUE_CHARS) return { ok: false, error: `"${col.title}" must be at most ${MAX_VALUE_CHARS} characters.`, fieldId: id }
    if (raw.trimStart().startsWith('=')) return { ok: false, error: `"${col.title}": a value cannot start with "=".`, fieldId: id }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) return { ok: false, error: `"${col.title}" contains characters that are not allowed.`, fieldId: id }
    const res = validateCell(col, raw, { rowCount: 1, ownRowNumber: 1, hoursPerDay: ctx.hoursPerDay, dependenciesEnabled: ctx.dependenciesEnabled })
    if (!res.ok) return { ok: false, error: `"${col.title}": ${res.error}`, fieldId: id }
    patch[id] = res.value
  }
  return { ok: true, patch }
}

function toRaw(v: unknown): string | null {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(',')
  return null
}
