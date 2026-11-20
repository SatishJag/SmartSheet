/**
 * Local date and time in an IANA time zone, for daily summaries and do-not-disturb hours. Pure; an
 * unknown zone falls back to UTC rather than throwing (settings are user input).
 */
export interface LocalTime {
  /** YYYY-MM-DD */
  date: string
  hour: number
  minute: number
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function localTime(ms: number, timeZone: string): LocalTime {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC'
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24, minute: Number(get('minute')) }
}

const toMinutes = (hhmm: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** True when the local time falls in [start, end); the window may wrap midnight. Equal ends = no DND. */
export function inQuietHours(t: Pick<LocalTime, 'hour' | 'minute'>, start: string, end: string): boolean {
  const s = toMinutes(start)
  const e = toMinutes(end)
  if (s === null || e === null || s === e) return false
  const now = t.hour * 60 + t.minute
  return s < e ? now >= s && now < e : now >= s || now < e
}

/** Minutes from `t` until the quiet hours end (0 when not in them). */
export function minutesUntilQuietEnds(t: Pick<LocalTime, 'hour' | 'minute'>, start: string, end: string): number {
  if (!inQuietHours(t, start, end)) return 0
  const e = toMinutes(end)!
  const now = t.hour * 60 + t.minute
  return (e - now + 1440) % 1440
}

const DAY_MS = 86_400_000
export const dayNumber = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS)
export const daysBetween = (fromIso: string, toIso: string) => dayNumber(toIso) - dayNumber(fromIso)
export const addDays = (iso: string, days: number) => new Date((dayNumber(iso) + days) * DAY_MS).toISOString().slice(0, 10)
