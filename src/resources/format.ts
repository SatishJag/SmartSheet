import { bucketStartDay, dayNumber, isoOfDay, nextBucketStartDay, type Allocation, type Bucket, type BucketUnit, type ResourceKind } from './engine'

/** 6, 6.5, 0.25, 4820.8 -> "6", "6.5", "0.3", "4,820.8": at most one decimal, no trailing zero, thousands separated. */
export function fmtHours(h: number): string {
  return (Math.round(h * 10) / 10).toLocaleString('en-GB', { maximumFractionDigits: 1 })
}

export const pct = (u: number | null) => (u === null ? '–' : `${Math.round(u * 100)}%`)

const DAY_FMT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
const SHORT_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const MONTH_FMT = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
const WEEKDAY_FMT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' })

const at = (iso: string) => new Date(`${iso}T00:00:00Z`)
/** "Mon 16 Nov" */
export const fmtDay = (iso: string) => DAY_FMT.format(at(iso))
/** "16 Nov" */
export const fmtShort = (iso: string) => SHORT_FMT.format(at(iso))
export const fmtWeekday = (iso: string) => WEEKDAY_FMT.format(at(iso))

/** The text on a heat-map column header, for a zoom level. */
export function bucketHeader(unit: BucketUnit, startIso: string): { top: string; bottom: string } {
  if (unit === 'day') return { top: fmtWeekday(startIso), bottom: String(at(startIso).getUTCDate()) }
  if (unit === 'week') return { top: fmtShort(startIso).split(' ')[1], bottom: String(at(startIso).getUTCDate()) }
  const [month, year] = MONTH_FMT.format(at(startIso)).split(' ')
  return { top: year, bottom: month }
}

/** A sentence for screen readers and tooltips: "Week of Mon 16 Nov: 32 of 40 h (80%), 1 day over". */
export function bucketLabel(unit: BucketUnit, b: Bucket): string {
  const when = unit === 'day' ? fmtDay(b.start) : unit === 'week' ? `Week of ${fmtDay(b.start)}` : MONTH_FMT.format(at(b.start))
  const over = b.overDays > 0 ? `, over-allocated on ${b.overDays} day${b.overDays === 1 ? '' : 's'}` : ''
  return `${when}: ${fmtHours(b.assigned)} of ${fmtHours(b.available)} h (${pct(b.utilization)})${over}`
}

export const KIND_LABEL: Record<ResourceKind, string> = { person: 'Person', role: 'Role', equipment: 'Equipment' }

export const ALLOCATION_LABEL: Record<Allocation['kind'], string> = {
  percent: '% of capacity',
  hours_per_day: 'Hours per day',
  hours_per_week: 'Hours per week',
  total_hours: 'Total hours',
}

/** "50%", "6 h/day", "20 h/week", "40 h total" */
export function fmtAllocation(a: Allocation): string {
  const v = fmtHours(a.value)
  switch (a.kind) {
    case 'percent':
      return `${v}%`
    case 'hours_per_day':
      return `${v} h/day`
    case 'hours_per_week':
      return `${v} h/week`
    case 'total_hours':
      return `${v} h total`
  }
}

export const ALLOCATION_MAX: Record<Allocation['kind'], number> = { percent: 1000, hours_per_day: 24, hours_per_week: 168, total_hours: 100000 }

/** Today as YYYY-MM-DD in the viewer's time zone. */
export function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** First bucket start and last bucket end (inclusive) for `count` buckets of `unit` from the one containing `anchor`. */
export function windowFor(unit: BucketUnit, anchor: string, count: number): { from: string; to: string; starts: string[] } {
  const starts: string[] = []
  let s = bucketStartDay(unit, dayNumber(anchor))
  const first = s
  for (let i = 0; i < count; i++) {
    starts.push(isoOfDay(s))
    s = nextBucketStartDay(unit, s)
  }
  return { from: isoOfDay(first), to: isoOfDay(s - 1), starts }
}

export const BUCKET_COUNT: Record<BucketUnit, number> = { day: 14, week: 12, month: 6 }

/** Moves an anchor date by whole buckets. */
export function shiftAnchor(unit: BucketUnit, anchor: string, buckets: number): string {
  let s = bucketStartDay(unit, dayNumber(anchor))
  if (unit === 'month') {
    const d = new Date(s * 86_400_000)
    return isoOfDay(Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + buckets, 1) / 86_400_000))
  }
  s += buckets * (unit === 'week' ? 7 : 1)
  return isoOfDay(s)
}
