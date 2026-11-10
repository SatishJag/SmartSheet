import { formatDuration, parseDuration } from '../engine/duration'
import { formatPredecessors, parsePredecessors } from '../engine/predecessor'

export type ColumnType =
  | 'TEXT_NUMBER'
  | 'DATE'
  | 'CHECKBOX'
  | 'PICKLIST'
  | 'MULTI_PICKLIST'
  | 'CONTACT_LIST'
  | 'DURATION'
  | 'PREDECESSOR'

export type ColumnRole = 'start' | 'end' | 'duration' | 'predecessor' | 'percentComplete' | 'status'

export interface Column {
  id: string
  title: string
  type: ColumnType
  options?: string[]
  systemType?: string
  role?: ColumnRole
}

export interface ValidateContext {
  rowCount: number
  ownRowNumber: number
  /** Working hours per day; defaults to 8. */
  hoursPerDay?: number
  /** Whether schedule columns are driven by dependencies; defaults to true. */
  dependenciesEnabled?: boolean
}

export type ValidateResult = { ok: true; value: unknown } | { ok: false; error: string }

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const FORMULA_BLOCKED_ROLES: readonly ColumnRole[] = ['start', 'end', 'duration', 'predecessor', 'percentComplete']

const ok = (value: unknown): ValidateResult => ({ ok: true, value })
const fail = (error: string): ValidateResult => ({ ok: false, error })

function isRealDate(s: string): boolean {
  const m = ISO_DATE.exec(s)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

function emptyValue(type: ColumnType): unknown {
  switch (type) {
    case 'CHECKBOX':
      return false
    case 'MULTI_PICKLIST':
      return []
    default:
      return null
  }
}

/** Validate and normalise a raw editor string for the given column. Pure. */
export function validateCell(col: Column, raw: string, ctx: ValidateContext): ValidateResult {
  const text = raw.trim()
  if (text === '') return ok(emptyValue(col.type))

  const hoursPerDay = ctx.hoursPerDay ?? 8

  if (text.startsWith('=')) {
    if (col.role && FORMULA_BLOCKED_ROLES.includes(col.role) && ctx.dependenciesEnabled !== false) {
      return fail(`Formulas are not allowed in ${col.role} columns`)
    }
    return ok(text)
  }

  switch (col.type) {
    case 'TEXT_NUMBER': {
      if (col.role === 'percentComplete') {
        const num = text.endsWith('%') ? text.slice(0, -1).trim() : text
        if (!NUMERIC.test(num)) return fail('Percent complete must be a number from 0 to 100')
        const n = Number(num)
        if (n < 0 || n > 100) return fail('Percent complete must be between 0 and 100')
        return ok(n)
      }
      return ok(NUMERIC.test(text) ? Number(text) : text)
    }
    case 'DATE':
      return isRealDate(text) ? ok(text) : fail('Enter a valid date as YYYY-MM-DD')
    case 'CHECKBOX': {
      const lower = text.toLowerCase()
      if (lower === 'true') return ok(true)
      if (lower === 'false') return ok(false)
      return fail('Checkbox must be true or false')
    }
    case 'PICKLIST': {
      const options = col.options ?? []
      return options.includes(text) ? ok(text) : fail(`Choose one of: ${options.join(', ')}`)
    }
    case 'MULTI_PICKLIST': {
      const options = col.options ?? []
      const items: string[] = []
      for (const part of text.split(',')) {
        const item = part.trim()
        if (!options.includes(item)) return fail(`"${item}" is not an allowed option (${options.join(', ')})`)
        if (!items.includes(item)) items.push(item)
      }
      return ok(items)
    }
    case 'CONTACT_LIST':
      return EMAIL.test(text) ? ok(text) : fail('Enter a valid email address')
    case 'DURATION': {
      const parsed = parseDuration(text, hoursPerDay)
      return parsed ? ok(formatDuration(parsed, hoursPerDay)) : fail('Enter a duration such as 4d, 2w or 4h 30m')
    }
    case 'PREDECESSOR': {
      const parsed = parsePredecessors(text, hoursPerDay)
      if (!parsed.ok) return fail(parsed.error)
      for (const p of parsed.value) {
        if (p.rowNumber > ctx.rowCount) return fail(`Row ${p.rowNumber} does not exist`)
        if (p.rowNumber === ctx.ownRowNumber) return fail('A row cannot depend on itself')
      }
      return ok(formatPredecessors(parsed.value, hoursPerDay))
    }
  }
}
