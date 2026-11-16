import { describe, expect, it } from 'vitest'
import { BUCKET_COUNT, bucketHeader, fmtAllocation, fmtDay, fmtHours, fmtShort, pct, shiftAnchor, windowFor } from './format'

describe('format', () => {
  it('rounds hours to one decimal and separates thousands', () => {
    expect(fmtHours(6)).toBe('6')
    expect(fmtHours(6.54)).toBe('6.5')
    expect(fmtHours(0.04)).toBe('0')
    expect(fmtHours(4820.84)).toBe('4,820.8')
  })

  it('formats percentages and allocations', () => {
    expect(pct(0.756)).toBe('76%')
    expect(pct(null)).toBe('–')
    expect(fmtAllocation({ kind: 'percent', value: 50 })).toBe('50%')
    expect(fmtAllocation({ kind: 'hours_per_day', value: 6.5 })).toBe('6.5 h/day')
    expect(fmtAllocation({ kind: 'hours_per_week', value: 20 })).toBe('20 h/week')
    expect(fmtAllocation({ kind: 'total_hours', value: 40 })).toBe('40 h total')
  })

  it('formats dates in UTC', () => {
    expect(fmtDay('2026-11-16')).toBe('Mon 16 Nov')
    expect(fmtShort('2026-11-16')).toBe('16 Nov')
    expect(bucketHeader('day', '2026-11-16')).toEqual({ top: 'Mon', bottom: '16' })
    expect(bucketHeader('week', '2026-11-16')).toEqual({ top: 'Nov', bottom: '16' })
    expect(bucketHeader('month', '2026-11-01')).toEqual({ top: '2026', bottom: 'Nov' })
  })

  it('builds the visible window from an anchor date', () => {
    const w = windowFor('week', '2026-11-18', BUCKET_COUNT.week)
    expect(w.from).toBe('2026-11-16')
    expect(w.starts).toHaveLength(12)
    expect(w.to).toBe('2027-02-07')
    const d = windowFor('day', '2026-11-18', 14)
    expect([d.from, d.to]).toEqual(['2026-11-18', '2026-12-01'])
    const m = windowFor('month', '2026-11-18', 6)
    expect([m.from, m.to, m.starts[5]]).toEqual(['2026-11-01', '2027-04-30', '2027-04-01'])
  })

  it('shifts an anchor by whole buckets, months by calendar months', () => {
    expect(shiftAnchor('week', '2026-11-18', 6)).toBe('2026-12-28')
    expect(shiftAnchor('week', '2026-11-18', -1)).toBe('2026-11-09')
    expect(shiftAnchor('day', '2026-11-18', 7)).toBe('2026-11-25')
    expect(shiftAnchor('month', '2026-11-18', 3)).toBe('2027-02-01')
    expect(shiftAnchor('month', '2026-11-18', -11)).toBe('2025-12-01')
  })
})
