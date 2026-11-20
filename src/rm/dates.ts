/** Calendar helpers for resource management: ISO dates (YYYY-MM-DD) in UTC, Mon-Fri working week. */

const DAY_MS = 86_400_000

export function parseIso(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export const toIso = (d: Date) => d.toISOString().slice(0, 10)

export const addDays = (iso: string, n: number) => toIso(new Date(parseIso(iso).getTime() + n * DAY_MS))

/** Calendar days from a to b (b - a). */
export const diffDays = (a: string, b: string) => Math.round((parseIso(b).getTime() - parseIso(a).getTime()) / DAY_MS)

/** 0 = Sunday ... 6 = Saturday. */
export const weekday = (iso: string) => parseIso(iso).getUTCDay()

export const isWorkingDay = (iso: string) => {
  const d = weekday(iso)
  return d !== 0 && d !== 6
}

/** The Monday of iso's week (weeks run Monday to Sunday). */
export const startOfWeek = (iso: string) => addDays(iso, -((weekday(iso) + 6) % 7))
export const endOfWeek = (iso: string) => addDays(startOfWeek(iso), 6)
export const startOfMonth = (iso: string) => `${iso.slice(0, 7)}-01`
export function endOfMonth(iso: string): string {
  const d = parseIso(startOfMonth(iso))
  return toIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)))
}
export const addMonths = (iso: string, n: number) => {
  const d = parseIso(startOfMonth(iso))
  return toIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)))
}

/** Working days from start to end, both inclusive (0 when end < start). */
export function workingDays(start: string, end: string): number {
  if (end < start) return 0
  const total = diffDays(start, end) + 1
  const full = Math.floor(total / 7) * 5
  let extra = 0
  const rem = total % 7
  const first = weekday(start)
  for (let i = 0; i < rem; i++) {
    const d = (first + i) % 7
    if (d !== 0 && d !== 6) extra++
  }
  return full + extra
}

/** The overlap of two inclusive ranges, or null. */
export function overlap(aStart: string, aEnd: string, bStart: string, bEnd: string): [string, string] | null {
  const s = aStart > bStart ? aStart : bStart
  const e = aEnd < bEnd ? aEnd : bEnd
  return s <= e ? [s, e] : null
}

/** "Nov 16" */
export function shortDate(iso: string): string {
  return parseIso(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** "11/16/2026" */
export function usDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${m}/${d}/${y}`
}

/** ISO week number (1-53). */
export function isoWeek(iso: string): number {
  const d = parseIso(iso)
  const thursday = new Date(d.getTime() + (3 - ((d.getUTCDay() + 6) % 7)) * DAY_MS)
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1))
  return Math.floor((thursday.getTime() - yearStart.getTime()) / DAY_MS / 7) + 1
}

/** Today's date in the viewer's local time zone, as ISO. */
export function localToday(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
