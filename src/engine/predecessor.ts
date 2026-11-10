import { formatDuration, parseDuration } from './duration'
import type { DepType } from './types'

export interface Pred {
  rowNumber: number
  type: DepType
  lagMinutes: number
}

export type PredParseResult = { ok: true; value: Pred[] } | { ok: false; error: string }

const DEP_TYPES: readonly string[] = ['FS', 'SS', 'FF', 'SF']

// <row> [<type>] [<sign><lag text>]
const ITEM = /^(\d+)\s*([A-Za-z]+)?\s*(?:([+-])\s*(.*))?$/

/**
 * Parse a predecessor string such as "12FS +3d 4h, 14SS". Row numbers start
 * at 1, the type defaults to FS, and lag/lead is signed ("+3d", "-2d").
 */
export function parsePredecessors(s: string, hoursPerDay = 8): PredParseResult {
  if (s.trim() === '') return { ok: true, value: [] }

  const value: Pred[] = []
  for (const raw of s.split(',')) {
    const item = raw.trim()
    if (item === '') return { ok: false, error: 'Empty predecessor in list' }

    const m = ITEM.exec(item)
    if (!m) {
      return {
        ok: false,
        error: `Invalid predecessor "${item}": expected a row number, optional type (FS, SS, FF, SF) and optional signed lag, e.g. "12FS +3d"`,
      }
    }
    const [, rowText, typeText, sign, lagText] = m

    const rowNumber = parseInt(rowText, 10)
    if (rowNumber < 1) {
      return { ok: false, error: `Invalid predecessor "${item}": row number must be 1 or greater` }
    }

    const type = (typeText ?? 'FS').toUpperCase()
    if (!DEP_TYPES.includes(type)) {
      return {
        ok: false,
        error: `Invalid predecessor "${item}": unknown dependency type "${typeText}" (use FS, SS, FF or SF)`,
      }
    }

    let lagMinutes = 0
    if (sign !== undefined) {
      const lag = parseDuration(lagText, hoursPerDay)
      if (!lag) {
        return { ok: false, error: `Invalid predecessor "${item}": cannot read lag "${sign}${lagText}"` }
      }
      if (lag.elapsed) {
        return { ok: false, error: `Invalid predecessor "${item}": elapsed lag is not supported` }
      }
      lagMinutes = sign === '-' ? -lag.minutes : lag.minutes
    }

    value.push({ rowNumber, type: type as DepType, lagMinutes })
  }
  return { ok: true, value }
}

/** Format predecessors as text, e.g. "12FS +3d 4h, 14SS". Always writes the type; omits zero lag. */
export function formatPredecessors(p: Pred[], hoursPerDay = 8): string {
  return p
    .map((pred) => {
      const base = `${pred.rowNumber}${pred.type}`
      if (pred.lagMinutes === 0) return base
      const sign = pred.lagMinutes < 0 ? '-' : '+'
      const lag = formatDuration({ minutes: Math.abs(pred.lagMinutes), elapsed: false }, hoursPerDay)
      return `${base} ${sign}${lag}`
    })
    .join(', ')
}
