export interface Duration {
  minutes: number
  elapsed: boolean
}

const SEGMENT = /^(\d+(?:\.\d+)?)([wdhm])$/i

/**
 * Parse a duration string such as "4d", "2w", "4h 30m" or "e3d".
 * Units: w (5 working days), d, h, m (case-insensitive). Segments are
 * whitespace-separated. An "e" prefix marks the whole duration as elapsed,
 * where a day is 24 hours. Returns null if the input is not valid.
 */
export function parseDuration(s: string, hoursPerDay = 8): Duration | null {
  let text = s.trim().toLowerCase()
  let elapsed = false
  if (text.startsWith('e')) {
    elapsed = true
    text = text.slice(1).trim()
  }
  if (text === '') return null

  const minutesPerDay = (elapsed ? 24 : hoursPerDay) * 60
  let minutes = 0
  for (const part of text.split(/\s+/)) {
    const m = SEGMENT.exec(part)
    if (!m) return null
    const value = parseFloat(m[1])
    switch (m[2]) {
      case 'w':
        minutes += value * 5 * minutesPerDay
        break
      case 'd':
        minutes += value * minutesPerDay
        break
      case 'h':
        minutes += value * 60
        break
      case 'm':
        minutes += value
        break
    }
  }
  return { minutes: Math.round(minutes), elapsed }
}

/** Format using days, hours and minutes (no weeks), e.g. "4d", "4h 30m", "e3d". */
export function formatDuration(d: Duration, hoursPerDay = 8): string {
  const minutesPerDay = (d.elapsed ? 24 : hoursPerDay) * 60
  const prefix = d.elapsed ? 'e' : ''
  if (d.minutes <= 0) return `${prefix}0d`

  const days = Math.floor(d.minutes / minutesPerDay)
  let rest = d.minutes - days * minutesPerDay
  const hours = Math.floor(rest / 60)
  rest -= hours * 60

  const parts: string[] = []
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (rest) parts.push(`${rest}m`)
  return prefix + parts.join(' ')
}

/** Number of whole days the duration spans, rounded up. */
export function toWorkingDays(d: Duration, hoursPerDay: number): number {
  if (d.minutes <= 0) return 0
  const minutesPerDay = (d.elapsed ? 24 : hoursPerDay) * 60
  return Math.ceil(d.minutes / minutesPerDay)
}
