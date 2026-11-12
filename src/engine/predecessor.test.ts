import { describe, expect, it } from 'vitest'
import { formatPredecessors, parsePredecessors } from './predecessor'

function ok(s: string, hoursPerDay?: number) {
  const r = parsePredecessors(s, hoursPerDay)
  if (!r.ok) throw new Error(`expected ok for "${s}": ${r.error}`)
  return r.value
}

describe('parsePredecessors', () => {
  it('parses type with positive lag', () => {
    expect(ok('12FS +3d 4h')).toEqual([{ rowNumber: 12, type: 'FS', lagMinutes: 1680 }])
  })

  it('parses type without lag', () => {
    expect(ok('14SS')).toEqual([{ rowNumber: 14, type: 'SS', lagMinutes: 0 }])
  })

  it('defaults to FS when type omitted', () => {
    expect(ok('7')).toEqual([{ rowNumber: 7, type: 'FS', lagMinutes: 0 }])
  })

  it('parses negative lag (lead)', () => {
    expect(ok('5FF -2d')).toEqual([{ rowNumber: 5, type: 'FF', lagMinutes: -960 }])
  })

  it('parses weeks and lag without a type', () => {
    expect(ok('3 +1w')).toEqual([{ rowNumber: 3, type: 'FS', lagMinutes: 2400 }])
  })

  it('parses multiple comma-separated items', () => {
    expect(ok('12FS +3d 4h, 14SS')).toEqual([
      { rowNumber: 12, type: 'FS', lagMinutes: 1680 },
      { rowNumber: 14, type: 'SS', lagMinutes: 0 },
    ])
  })

  it('is case-insensitive and normalizes type to upper case', () => {
    expect(ok('9sf')).toEqual([{ rowNumber: 9, type: 'SF', lagMinutes: 0 }])
  })

  it('honours hoursPerDay for lag', () => {
    expect(ok('2FS +1d', 10)).toEqual([{ rowNumber: 2, type: 'FS', lagMinutes: 600 }])
  })

  it('returns an empty list for empty or whitespace input', () => {
    expect(parsePredecessors('')).toEqual({ ok: true, value: [] })
    expect(parsePredecessors('   ')).toEqual({ ok: true, value: [] })
  })

  it.each(['bad', '12XX', '0', '-3', '12FS 3d', '12FS +', '12FS +xyz', '12FS +e2d', '1,,2', '12FS,'])(
    'rejects %j with a message',
    (input) => {
      const r = parsePredecessors(input)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
    },
  )

  it('names the offending item in the error', () => {
    const r = parsePredecessors('1FS, 12XX')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('12XX')
  })
})

describe('formatPredecessors', () => {
  it('round-trips "12FS +3d 4h"', () => {
    expect(formatPredecessors(ok('12FS +3d 4h'))).toBe('12FS +3d 4h')
  })

  it('always writes the type and omits zero lag', () => {
    expect(formatPredecessors(ok('7'))).toBe('7FS')
  })

  it('writes leads with a minus sign', () => {
    expect(formatPredecessors(ok('5FF -2d'))).toBe('5FF -2d')
  })

  it('joins multiple items with ", "', () => {
    expect(formatPredecessors(ok('12FS +3d 4h, 14SS'))).toBe('12FS +3d 4h, 14SS')
  })

  it('formats an empty list as an empty string', () => {
    expect(formatPredecessors([])).toBe('')
  })
})
