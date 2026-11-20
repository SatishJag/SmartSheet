/** Reading and comparing cell values the way rules need them. Pure. */
import type { Column } from '../model/validate'
import { isIsoDate } from './time'

export type Cells = Record<string, unknown>

const EMAIL_G = /[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+/g

export function isBlank(v: unknown, col?: Pick<Column, 'type'>): boolean {
  if (v == null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'boolean') return col?.type === 'CHECKBOX' ? !v : false
  return false
}

/** A cell as text (what a person would read). */
export function formatValue(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v)) return v.map(formatValue).join(', ')
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

const norm = (s: string) => s.trim().toLowerCase()

function numberOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(v.trim())) return Number(v)
  return null
}

function boolOf(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const l = norm(v)
    if (l === 'true') return true
    if (l === 'false') return false
  }
  return null
}

/** Equality as a user means "is": case-insensitive text, numeric when both are numbers, multi-pick as a set. */
export function looseEquals(a: unknown, b: unknown, col?: Pick<Column, 'type'>): boolean {
  if (col?.type === 'CHECKBOX') return (boolOf(a) ?? false) === (boolOf(b) ?? false)
  if (isBlank(a, col) && isBlank(b, col)) return true
  if (isBlank(a, col) || isBlank(b, col)) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    const la = (Array.isArray(a) ? a : [a]).map((x) => norm(formatValue(x)))
    const lb = (Array.isArray(b) ? b : [b]).map((x) => norm(formatValue(x)))
    return la.length === lb.length && la.every((x) => lb.includes(x))
  }
  const ba = boolOf(a)
  const bb = boolOf(b)
  if (ba !== null && bb !== null) return ba === bb
  const na = numberOf(a)
  const nb = numberOf(b)
  if (na !== null && nb !== null) return na === nb
  return norm(formatValue(a)) === norm(formatValue(b))
}

/** Whether the cell "contains" `needle`: a substring of the text, or one of a multi-pick's options. */
export function containsValue(v: unknown, needle: unknown): boolean {
  const n = norm(formatValue(needle))
  if (n === '') return false
  if (Array.isArray(v)) return v.some((x) => norm(formatValue(x)).includes(n))
  return norm(formatValue(v)).includes(n)
}

/** Orders two values as numbers or as ISO dates; null when they are not comparable. */
export function compareValues(a: unknown, b: unknown): number | null {
  const na = numberOf(a)
  const nb = numberOf(b)
  if (na !== null && nb !== null) return na - nb
  if (isIsoDate(a) && isIsoDate(b)) return a < b ? -1 : a > b ? 1 : 0
  return null
}

/** Every e-mail address in a cell (a contact cell, free text or a multi-pick), lower-cased and unique. */
export function emailsIn(v: unknown): string[] {
  const text = Array.isArray(v) ? v.map(formatValue).join(',') : formatValue(v)
  const out: string[] = []
  for (const m of text.match(EMAIL_G) ?? []) {
    const e = m.toLowerCase()
    if (!out.includes(e)) out.push(e)
  }
  return out
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
