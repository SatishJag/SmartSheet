import type { SheetData } from '../store/persistence'
import type { Column, ColumnRole, ColumnType } from './validate'

/** Column rules shared by the store (which enforces them) and the grid header (which explains them). */

export const MAX_COLUMN_TITLE_LENGTH = 100

/** Types a user can give a column. Predecessor columns come only from templates (they hold dependencies). */
export const USER_COLUMN_TYPES: readonly ColumnType[] = [
  'TEXT_NUMBER',
  'DATE',
  'CHECKBOX',
  'PICKLIST',
  'MULTI_PICKLIST',
  'CONTACT_LIST',
  'DURATION',
]

export const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
  TEXT_NUMBER: 'Text/Number',
  DATE: 'Date',
  CHECKBOX: 'Checkbox',
  PICKLIST: 'Dropdown (single)',
  MULTI_PICKLIST: 'Dropdown (multiple)',
  CONTACT_LIST: 'Contact',
  DURATION: 'Duration',
  PREDECESSOR: 'Predecessors',
}

export const isPicklistType = (type: ColumnType) => type === 'PICKLIST' || type === 'MULTI_PICKLIST'

/** Roles the scheduler reads; their columns are fixed while dependencies are enabled. */
const SCHEDULE_ROLES: readonly ColumnRole[] = ['start', 'end', 'duration', 'predecessor', 'percentComplete']

/**
 * A column title as typed: trimmed, non-empty, at most 100 characters, no square brackets (formulas
 * reference columns as [Title]) and unique in the sheet ignoring case. `selfId` is the column being
 * renamed, which may keep its own title.
 */
export function validateColumnTitle(
  raw: string,
  columns: readonly Column[],
  selfId?: string,
): { ok: true; title: string } | { ok: false; error: string } {
  const title = raw.trim()
  if (title === '') return { ok: false, error: 'Enter a column name' }
  if (title.length > MAX_COLUMN_TITLE_LENGTH) {
    return { ok: false, error: `Column names can be at most ${MAX_COLUMN_TITLE_LENGTH} characters` }
  }
  if (/[[\]]/.test(title)) return { ok: false, error: 'Column names cannot contain [ or ]' }
  const lower = title.toLowerCase()
  const clash = columns.find((c) => c.id !== selfId && c.title.toLowerCase() === lower)
  if (clash) return { ok: false, error: `A column named "${clash.title}" already exists` }
  return { ok: true, title }
}

/** Dropdown options as entered: trimmed, blanks and duplicates dropped; at least one, no commas. */
export function normalizeOptions(raw: readonly string[]): { ok: true; options: string[] } | { ok: false; error: string } {
  const options: string[] = []
  for (const r of raw) {
    const o = r.trim()
    if (o === '' || options.includes(o)) continue
    if (o.includes(',')) return { ok: false, error: `Options cannot contain commas ("${o}")` }
    options.push(o)
  }
  if (options.length === 0) return { ok: false, error: 'Add at least one option' }
  return { ok: true, options }
}

/**
 * Rewrites `[oldTitle]` column references in a formula to `[newTitle]`. Matching is exact on the
 * trimmed text between the brackets (as the evaluator resolves titles); string literals are left
 * alone. Returns the input itself when nothing changed.
 */
export function renameFormulaReferences(formula: string, oldTitle: string, newTitle: string): string {
  let out = ''
  let changed = false
  let i = 0
  while (i < formula.length) {
    const c = formula[i]
    if (c === '"') {
      const end = formula.indexOf('"', i + 1)
      const stop = end === -1 ? formula.length : end + 1
      out += formula.slice(i, stop)
      i = stop
    } else if (c === '[') {
      const end = formula.indexOf(']', i + 1)
      if (end === -1) {
        out += formula.slice(i)
        break
      }
      if (formula.slice(i + 1, end).trim() === oldTitle) {
        out += `[${newTitle}]`
        changed = true
      } else out += formula.slice(i, end + 1)
      i = end + 1
    } else {
      out += c
      i++
    }
  }
  return changed ? out : formula
}

/**
 * Why a column cannot be deleted or have its type changed, or null when it can. The primary
 * (first) column holds the row hierarchy and is never removed or retyped; schedule columns are
 * fixed while the sheet's dependencies are enabled.
 */
export function columnLock(data: SheetData, colId: string, action: 'delete' | 'retype'): string | null {
  const index = data.columns.findIndex((c) => c.id === colId)
  if (index < 0) return null
  const col = data.columns[index]
  const verb = action === 'delete' ? 'be deleted' : 'change type'
  if (index === 0) return `The primary column cannot ${verb}`
  if (data.sheet.dependenciesEnabled && col.role && SCHEDULE_ROLES.includes(col.role)) {
    return `"${col.title}" is used for scheduling and cannot ${verb} while dependencies are enabled`
  }
  return null
}
