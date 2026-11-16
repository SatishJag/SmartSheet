import { describe, expect, it } from 'vitest'
import { formatTick, niceTicks, pieSlices, slicePath, truncate } from './chartMath'

describe('niceTicks', () => {
  it('rounds up to a friendly step and includes 0', () => {
    expect(niceTicks(0, 87).values).toEqual([0, 50, 100])
    expect(niceTicks(0, 87).max).toBe(100)
    expect(niceTicks(0, 7).values).toEqual([0, 2, 4, 6, 8])
    expect(niceTicks(0, 400).values).toEqual([0, 100, 200, 300, 400])
  })
  it('handles negatives and empty data', () => {
    const t = niceTicks(-30, 50)
    expect(t.min).toBeLessThanOrEqual(-30)
    expect(t.max).toBeGreaterThanOrEqual(50)
    expect(t.values).toContain(0)
    expect(niceTicks(0, 0)).toEqual({ values: [0, 1], min: 0, max: 1 })
  })
})

describe('formatTick', () => {
  it('abbreviates big numbers only', () => {
    expect(formatTick(1234).replace(/\D/g, '')).toBe('1234')
    expect(formatTick(12_500)).toMatch(/12[.,]5/)
    expect(formatTick(12_500).length).toBeLessThan(7)
  })
})

describe('pieSlices', () => {
  it('splits a circle by value, skipping zero and negative values', () => {
    const slices = pieSlices([1, 0, 3, -2])
    expect(slices.map((s) => s.index)).toEqual([0, 2])
    expect(slices[0].share).toBeCloseTo(0.25)
    expect(slices[1].share).toBeCloseTo(0.75)
    expect(slices[1].end).toBeCloseTo(Math.PI * 2)
    expect(pieSlices([0, 0])).toEqual([])
  })
})

describe('slicePath', () => {
  it('draws a closed arc, a ring segment, and a full circle', () => {
    expect(slicePath(50, 50, 40, 0, 0, Math.PI / 2)).toMatch(/^M50 50L50 10A40 40 0 0 1 90 50Z$/)
    expect(slicePath(50, 50, 40, 20, 0, Math.PI / 2)).toMatch(/A20 20 0 0 0/)
    expect(slicePath(50, 50, 40, 0, 0, Math.PI * 2)).toMatch(/^M50 50L/)
  })
})

describe('truncate', () => {
  it('cuts long labels with an ellipsis', () => {
    expect(truncate('short', 10)).toBe('short')
    expect(truncate('a very long label', 8)).toBe('a very …')
  })
})
