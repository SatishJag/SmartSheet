import { diffDays } from './dates'
import type { Period, Zoom } from './metrics'

export const COLUMN_WIDTH: Record<Zoom, number> = { day: 44, week: 128, month: 150 }
export const PERIOD_COUNT: Record<Zoom, number> = { day: 35, week: 16, month: 12 }

/**
 * Horizontal position of the START of `iso` (or of the day after `iso` when `endOfDay`), on a
 * timeline of equal-width columns, one per period. Clamped to the timeline.
 */
export function xOf(periods: readonly Period[], width: number, iso: string, endOfDay = false): number {
  if (periods.length === 0) return 0
  if (iso < periods[0].start) return 0
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i]
    if (iso <= p.end) {
      const len = diffDays(p.start, p.end) + 1
      const offset = diffDays(p.start, iso) + (endOfDay ? 1 : 0)
      return i * width + (offset / len) * width
    }
  }
  return periods.length * width
}

/** The date under horizontal position x (inverse of xOf). */
export function dateAt(periods: readonly Period[], width: number, x: number): string {
  const i = Math.min(periods.length - 1, Math.max(0, Math.floor(x / width)))
  const p = periods[i]
  const len = diffDays(p.start, p.end) + 1
  const day = Math.min(len - 1, Math.max(0, Math.floor(((x - i * width) / width) * len)))
  const d = new Date(Date.parse(`${p.start}T00:00:00Z`) + day * 86_400_000)
  return d.toISOString().slice(0, 10)
}

/** Pixels per calendar day at a zoom level (months use an average month). */
export const pxPerDay = (zoom: Zoom) => COLUMN_WIDTH[zoom] / (zoom === 'day' ? 1 : zoom === 'week' ? 7 : 30.44)
