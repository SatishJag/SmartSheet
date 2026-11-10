import { describe, it, expect } from 'vitest'
import { defaultCalendar } from './calendar'
import { schedule, type SchedDep, type SchedRow } from './schedule'
import type { DepType } from './types'

const DAY = 8 * 60 // minutes in one working day with the default calendar

function row(id: string, days: number, manualStart: string | null = null, elapsed = false): SchedRow {
  const minutesPerDay = elapsed ? 24 * 60 : DAY
  return { id, parentId: null, durationMinutes: days * minutesPerDay, elapsed, manualStart, percentComplete: 0 }
}

function dep(predecessorId: string, successorId: string, type: DepType = 'FS', lagDays = 0): SchedDep {
  return { predecessorId, successorId, type, lagMinutes: lagDays * DAY }
}

// 2026-11-09 is a Monday. A runs Mon 11-09 -> Wed 11-11.
const A = row('A', 3, '2026-11-09')

describe('schedule', () => {
  it('schedules a row from its manual start', () => {
    const { byRow, errors } = schedule([A], [], defaultCalendar)
    expect(errors).toEqual([])
    expect(byRow.A).toEqual({ start: '2026-11-09', end: '2026-11-11', durationDays: 3, percentComplete: 0 })
  })

  it('FS: successor starts the next working day after the predecessor ends', () => {
    const { byRow } = schedule([A, row('B', 2)], [dep('A', 'B')], defaultCalendar)
    expect(byRow.B.start).toBe('2026-11-12')
    expect(byRow.B.end).toBe('2026-11-13')
  })

  it('FS with +1d lag', () => {
    const { byRow } = schedule([A, row('B', 2)], [dep('A', 'B', 'FS', 1)], defaultCalendar)
    expect(byRow.B.start).toBe('2026-11-13')
  })

  it('FS with -1d lead', () => {
    const { byRow } = schedule([A, row('B', 2)], [dep('A', 'B', 'FS', -1)], defaultCalendar)
    expect(byRow.B.start).toBe('2026-11-11')
  })

  it('SS with zero lag', () => {
    const { byRow } = schedule([A, row('B', 2)], [dep('A', 'B', 'SS')], defaultCalendar)
    expect(byRow.B.start).toBe('2026-11-09')
  })

  it('FF: successor ends when the predecessor ends', () => {
    const { byRow } = schedule([A, row('B', 2)], [dep('A', 'B', 'FF')], defaultCalendar)
    expect(byRow.B.end).toBe('2026-11-11')
    expect(byRow.B.start).toBe('2026-11-10')
  })

  it('SF: successor ends when the predecessor starts, start crossing a weekend backwards', () => {
    const { byRow } = schedule([A, row('B', 2)], [dep('A', 'B', 'SF')], defaultCalendar)
    expect(byRow.B.end).toBe('2026-11-09')
    expect(byRow.B.start).toBe('2026-11-06') // Friday before
  })

  it('two predecessors: the later constraint wins', () => {
    const C = row('C', 5, '2026-11-09') // Mon 11-09 -> Fri 11-13
    const rows = [A, C, row('B', 1)]
    const { byRow } = schedule(rows, [dep('A', 'B'), dep('C', 'B')], defaultCalendar)
    expect(byRow.B.start).toBe('2026-11-16')
    // order of deps does not matter
    const again = schedule(rows, [dep('C', 'B'), dep('A', 'B')], defaultCalendar)
    expect(again.byRow.B.start).toBe('2026-11-16')
  })

  it('a 0-minute row is a milestone (start equals end)', () => {
    const { byRow } = schedule([A, row('M', 0)], [dep('A', 'M')], defaultCalendar)
    expect(byRow.M).toEqual({ start: '2026-11-12', end: '2026-11-12', durationDays: 0, percentComplete: 0 })
  })

  it('a partial day counts as at least one day', () => {
    const r: SchedRow = { ...row('H', 0, '2026-11-09'), durationMinutes: 30 }
    const { byRow } = schedule([r], [], defaultCalendar)
    expect(byRow.H).toMatchObject({ start: '2026-11-09', end: '2026-11-09', durationDays: 1 })
  })

  it('a manual start on a Saturday moves to the next Monday', () => {
    const { byRow } = schedule([row('S', 1, '2026-11-14')], [], defaultCalendar)
    expect(byRow.S.start).toBe('2026-11-16')
  })

  it('an elapsed e3d row starting Friday ends Sunday', () => {
    const { byRow } = schedule([row('E', 3, '2026-11-13', true)], [], defaultCalendar)
    expect(byRow.E).toMatchObject({ start: '2026-11-13', end: '2026-11-15', durationDays: 3 })
  })

  it('a row with predecessors ignores its manual start', () => {
    const B = row('B', 2, '2026-12-01')
    const { byRow } = schedule([A, B], [dep('A', 'B')], defaultCalendar)
    expect(byRow.B.start).toBe('2026-11-12')
  })

  it('passes percentComplete through', () => {
    const { byRow } = schedule([{ ...A, percentComplete: 40 }], [], defaultCalendar)
    expect(byRow.A.percentComplete).toBe(40)
  })

  it('a row with neither predecessors nor a manual start gets "No start date"', () => {
    const { byRow, errors } = schedule([row('N', 2)], [], defaultCalendar)
    expect(byRow.N).toBeUndefined()
    expect(errors).toEqual([{ rowId: 'N', message: 'No start date' }])
  })

  it('an unknown predecessor id puts an error on the successor and the dependency is ignored', () => {
    const B = row('B', 2, '2026-11-09')
    const { byRow, errors } = schedule([B], [dep('ZZZ', 'B')], defaultCalendar)
    expect(errors).toHaveLength(1)
    expect(errors[0].rowId).toBe('B')
    expect(errors[0].message).toContain('ZZZ')
    expect(byRow.B.start).toBe('2026-11-09')
  })

  it('a successor of an unschedulable predecessor is left out with an error', () => {
    const { byRow, errors } = schedule([row('N', 2), row('B', 2)], [dep('N', 'B')], defaultCalendar)
    expect(byRow.N).toBeUndefined()
    expect(byRow.B).toBeUndefined()
    expect(errors).toContainEqual({ rowId: 'N', message: 'No start date' })
    expect(errors).toContainEqual({ rowId: 'B', message: 'Predecessor N could not be scheduled' })
  })

  it('processes rows in dependency order regardless of row order', () => {
    const rows = [row('C', 1), row('B', 2), A]
    const { byRow } = schedule(rows, [dep('B', 'C'), dep('A', 'B')], defaultCalendar)
    expect(byRow.B.start).toBe('2026-11-12')
    expect(byRow.C.start).toBe('2026-11-16')
  })

  it('rows in a cycle get "Dependency cycle" errors and do not hang or throw', () => {
    const rows = [A, row('X', 1), row('Y', 1)]
    const deps = [dep('A', 'X'), dep('X', 'Y'), dep('Y', 'X')]
    const { byRow, errors } = schedule(rows, deps, defaultCalendar)
    expect(byRow.A).toBeDefined()
    expect(byRow.X).toBeUndefined()
    expect(byRow.Y).toBeUndefined()
    expect(errors).toContainEqual({ rowId: 'X', message: 'Dependency cycle' })
    expect(errors).toContainEqual({ rowId: 'Y', message: 'Dependency cycle' })
  })

  it('an elapsed successor with FF derives its start in calendar days', () => {
    const E = row('E', 3, null, true)
    const { byRow } = schedule([A, E], [dep('A', 'E', 'FF')], defaultCalendar)
    expect(byRow.E).toMatchObject({ start: '2026-11-09', end: '2026-11-11', durationDays: 3 })
  })
})
