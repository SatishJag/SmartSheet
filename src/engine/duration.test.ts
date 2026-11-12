import { describe, expect, it } from 'vitest'
import { formatDuration, parseDuration, toWorkingDays } from './duration'

describe('parseDuration', () => {
  it('parses days', () => {
    expect(parseDuration('4d')).toEqual({ minutes: 1920, elapsed: false })
  })
  it('parses weeks as 5 working days', () => {
    expect(parseDuration('2w')).toEqual({ minutes: 4800, elapsed: false })
  })
  it('parses multiple segments', () => {
    expect(parseDuration('4h 30m')?.minutes).toBe(270)
  })
  it('parses elapsed durations', () => {
    expect(parseDuration('e3d')).toEqual({ minutes: 4320, elapsed: true })
  })
  it('parses zero', () => {
    expect(parseDuration('0d')?.minutes).toBe(0)
  })
  it('is case-insensitive', () => {
    expect(parseDuration('4D')).toEqual({ minutes: 1920, elapsed: false })
    expect(parseDuration('E3D')).toEqual({ minutes: 4320, elapsed: true })
  })
  it('honours hoursPerDay', () => {
    expect(parseDuration('1d', 10)?.minutes).toBe(600)
  })
  it('returns null for invalid input', () => {
    expect(parseDuration('banana')).toBeNull()
    expect(parseDuration('')).toBeNull()
    expect(parseDuration('   ')).toBeNull()
    expect(parseDuration('e')).toBeNull()
    expect(parseDuration('4')).toBeNull()
  })
})

describe('formatDuration', () => {
  it('round-trips 4d', () => {
    expect(formatDuration(parseDuration('4d')!)).toBe('4d')
  })
  it('formats days, hours and minutes', () => {
    expect(formatDuration({ minutes: 1920 + 270, elapsed: false })).toBe('4d 4h 30m')
  })
  it('formats elapsed with e prefix', () => {
    expect(formatDuration({ minutes: 4320, elapsed: true })).toBe('e3d')
  })
  it('formats zero', () => {
    expect(formatDuration({ minutes: 0, elapsed: false })).toBe('0d')
  })
})

describe('toWorkingDays', () => {
  it('rounds up to whole days', () => {
    expect(toWorkingDays({ minutes: 60, elapsed: false }, 8)).toBe(1)
    expect(toWorkingDays({ minutes: 1920, elapsed: false }, 8)).toBe(4)
    expect(toWorkingDays({ minutes: 1921, elapsed: false }, 8)).toBe(5)
  })
  it('returns 0 for zero minutes', () => {
    expect(toWorkingDays({ minutes: 0, elapsed: false }, 8)).toBe(0)
  })
  it('uses 24h days for elapsed durations', () => {
    expect(toWorkingDays({ minutes: 4320, elapsed: true }, 8)).toBe(3)
  })
})
