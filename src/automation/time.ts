/**
 * Calendar maths for the engine. Everything takes the clock as an argument (ms since epoch) and a
 * time-zone offset in minutes east of UTC (`tzOffsetMinutes`, e.g. +60 for UTC+1; default 0), so
 * tests are deterministic and the server can run in UTC while the browser passes the user's offset.
 */
import type { Trigger } from './types'

const DAY_MS = 86_400_000

export const isoDate = (utcMs: number): string => new Date(utcMs).toISOString().slice(0, 10)

/** The date (YYYY-MM-DD) it is at `now` for someone at `tzOffsetMinutes` east of UTC. */
export function todayIso(now: number, tzOffsetMinutes = 0): string {
  return isoDate(now + tzOffsetMinutes * 60_000)
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string') return false
  const m = ISO.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

export function addDays(iso: string, days: number): string {
  const m = ISO.exec(iso)!
  return isoDate(Date.UTC(+m[1], +m[2] - 1, +m[3]) + days * DAY_MS)
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = ISO.exec(fromIso)!
  const b = ISO.exec(toIso)!
  return Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / DAY_MS)
}

/** The date on which a `date` trigger fires for a row whose date column holds `rowDate`. */
export function dateTriggerTarget(rowDate: string, when: 'before' | 'on' | 'after', days: number): string {
  if (when === 'on') return rowDate
  return addDays(rowDate, when === 'before' ? -days : days)
}

export function parseTime(time: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (!m || +m[1] > 23 || +m[2] > 59) return null
  return { h: +m[1], m: +m[2] }
}

const daysInMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate()

/**
 * The latest scheduled instant at or before `now` (ms), or null for an invalid schedule. Wall-clock
 * fields are computed in the shifted frame `now + offset` and converted back.
 */
export function latestOccurrence(
  s: Extract<Trigger, { type: 'schedule' }>,
  now: number,
  tzOffsetMinutes = 0,
): number | null {
  const t = parseTime(s.time)
  if (!t) return null
  const off = tzOffsetMinutes * 60_000
  const local = new Date(now + off)
  const y = local.getUTCFullYear()
  const mo = local.getUTCMonth()
  const d = local.getUTCDate()
  const at = (yy: number, mm: number, dd: number) => Date.UTC(yy, mm, dd, t.h, t.m) - off

  if (s.frequency === 'daily') {
    const today = at(y, mo, d)
    return today <= now ? today : today - DAY_MS
  }
  if (s.frequency === 'weekly') {
    const wd = s.weekday ?? 1
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) return null
    const back = (local.getUTCDay() - wd + 7) % 7
    const cand = at(y, mo, d - back)
    return cand <= now ? cand : cand - 7 * DAY_MS
  }
  const dom = s.dayOfMonth ?? 1
  if (!Number.isInteger(dom) || dom < 1 || dom > 31) return null
  const inMonth = (yy: number, mm: number) => at(yy, mm, Math.min(dom, daysInMonth(yy, mm)))
  const here = inMonth(y, mo)
  if (here <= now) return here
  return mo === 0 ? inMonth(y - 1, 11) : inMonth(y, mo - 1)
}

/** When a digest is next delivered: daily at 08:00, weekly on Monday 08:00 (in the user's time zone). */
export function nextDigestTime(frequency: 'daily' | 'weekly', now: number, tzOffsetMinutes = 0): number {
  const off = tzOffsetMinutes * 60_000
  const local = new Date(now + off)
  const base = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 8, 0) - off
  if (frequency === 'daily') return base > now ? base : base + DAY_MS
  const untilMonday = (1 - local.getUTCDay() + 7) % 7
  const cand = base + untilMonday * DAY_MS
  return cand > now ? cand : cand + 7 * DAY_MS
}
