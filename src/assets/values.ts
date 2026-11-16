import { parseDuration } from '../engine/duration'
import type { ColumnType } from '../model/validate'

/** Helpers shared by the report and widget engines: blanks, numbers, dates, text and ordering. Pure. */

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)%?$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A blank cell: nothing, an empty list, or (for a checkbox) unchecked. Numbers and ticked boxes are
 * never blank, so `0` counts as a value.
 */
export function isBlank(value: unknown, type?: ColumnType): boolean {
  if (type === 'CHECKBOX') return value !== true
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/** A number for arithmetic: numbers, and text that is only a number ("12", "7.5%"). Otherwise null. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const t = value.trim()
    if (NUMERIC.test(t)) return Number(t.endsWith('%') ? t.slice(0, -1) : t)
  }
  return null
}

/** What a cell looks like as text: lists joined, checkboxes Yes / No, blank as an empty string. */
export function formatValue(value: unknown, type?: ColumnType): string {
  if (type === 'CHECKBOX') return value === true ? 'Yes' : 'No'
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

// ---- dates ----

export const isIsoDate = (s: unknown): s is string => typeof s === 'string' && ISO_DATE.test(s)

function utc(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

export function addDays(iso: string, days: number): string {
  return new Date(utc(iso) + days * 86_400_000).toISOString().slice(0, 10)
}

export const daysBetween = (fromIso: string, toIso: string) => Math.round((utc(toIso) - utc(fromIso)) / 86_400_000)

/** Today as YYYY-MM-DD in the local time zone. */
export function todayIso(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

const TODAY_TOKEN = /^today\s*(?:([+-])\s*(\d+))?$/i

/** `today`, `today+7`, `today-3` become a date; anything else comes back trimmed and unchanged. */
export function resolveDateToken(text: string, today: string): string {
  const t = text.trim()
  const m = TODAY_TOKEN.exec(t)
  if (!m) return t
  return m[1] ? addDays(today, (m[1] === '-' ? -1 : 1) * Number(m[2])) : today
}

// ---- ordering ----

/** A comparable key: numbers sort before dates, dates before text; null = blank (always last). */
export type SortKey = { k: 0; n: number } | { k: 1 | 2; s: string }

export function sortKeyOf(value: unknown, type?: ColumnType): SortKey | null {
  if (type === 'CHECKBOX') return { k: 0, n: value === true ? 1 : 0 }
  if (isBlank(value)) return null
  if (type === 'DURATION' && typeof value === 'string') {
    const d = parseDuration(value)
    if (d) return { k: 0, n: d.minutes }
  }
  const n = toNumber(value)
  if (n !== null) return { k: 0, n }
  const s = formatValue(value).trim()
  return type === 'DATE' || isIsoDate(s) ? { k: 1, s } : { k: 2, s }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function compareKeys(a: SortKey, b: SortKey): number {
  if (a.k !== b.k) return a.k - b.k
  if (a.k === 0) return a.n - (b as typeof a).n
  const bs = (b as { s: string }).s
  return a.k === 1 ? (a.s < bs ? -1 : a.s > bs ? 1 : 0) : collator.compare(a.s, bs)
}

/** Sort comparison with blanks last whichever the direction. */
export function compareWithBlanks(a: SortKey | null, b: SortKey | null, dir: 'asc' | 'desc'): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1
  const c = compareKeys(a, b)
  return dir === 'asc' ? c : -c
}
