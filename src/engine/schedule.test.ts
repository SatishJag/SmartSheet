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
    expect(errors).toContainEqual({ rowId: 'X', message: 'Dependency cycle: X -> Y -> X' })
    expect(errors).toContainEqual({ rowId: 'Y', message: 'Dependency cycle: X -> Y -> X' })
  })

  it('an elapsed successor with FF derives its start in calendar days', () => {
    const E = row('E', 3, null, true)
    const { byRow } = schedule([A, E], [dep('A', 'E', 'FF')], defaultCalendar)
    expect(byRow.E).toMatchObject({ start: '2026-11-09', end: '2026-11-11', durationDays: 3 })
  })
})

describe('schedule: predecessors ending on a non-working day (elapsed)', () => {
  // e6d from Mon 11-09 ends Sat 11-14; e7d ends Sun 11-15.
  const SAT = row('P', 6, '2026-11-09', true)
  const SUN = row('P', 7, '2026-11-09', true)

  for (const [label, P] of [['Saturday', SAT], ['Sunday', SUN]] as const) {
    it(`FS lag 0 after a ${label} end starts the next Monday`, () => {
      const { byRow } = schedule([P, row('B', 2)], [dep('P', 'B')], defaultCalendar)
      expect(byRow.B.start).toBe('2026-11-16')
    })

    it(`FS +1d after a ${label} end starts Tuesday`, () => {
      const { byRow } = schedule([P, row('B', 2)], [dep('P', 'B', 'FS', 1)], defaultCalendar)
      expect(byRow.B.start).toBe('2026-11-17')
    })

    it(`FS -1d after a ${label} end starts the Friday before`, () => {
      const { byRow } = schedule([P, row('B', 2)], [dep('P', 'B', 'FS', -1)], defaultCalendar)
      expect(byRow.B.start).toBe('2026-11-13')
    })

    it(`FF lag 0 after a ${label} end finishes Monday`, () => {
      const { byRow } = schedule([P, row('B', 2)], [dep('P', 'B', 'FF')], defaultCalendar)
      expect(byRow.B).toMatchObject({ start: '2026-11-13', end: '2026-11-16' })
    })

    it(`FF +1d after a ${label} end finishes Monday (the first working day after)`, () => {
      const { byRow } = schedule([P, row('B', 2)], [dep('P', 'B', 'FF', 1)], defaultCalendar)
      expect(byRow.B).toMatchObject({ start: '2026-11-13', end: '2026-11-16' })
    })

    it(`FF -1d after a ${label} end finishes the Friday before`, () => {
      const { byRow } = schedule([P, row('B', 2)], [dep('P', 'B', 'FF', -1)], defaultCalendar)
      expect(byRow.B).toMatchObject({ start: '2026-11-12', end: '2026-11-13' })
    })
  }

  it('FF +1d after a working-day end is unchanged (one working day later)', () => {
    const { byRow } = schedule([A, row('B', 2)], [dep('A', 'B', 'FF', 1)], defaultCalendar)
    expect(byRow.B.end).toBe('2026-11-12')
  })

  it('SS/SF use the predecessor start, which is always a working day, so elapsed ends do not affect them', () => {
    const { byRow } = schedule(
      [SUN, row('S', 2), { ...row('F', 2), id: 'F' }],
      [dep('P', 'S', 'SS', 1), dep('P', 'F', 'SF', 1)],
      defaultCalendar,
    )
    expect(byRow.S.start).toBe('2026-11-10')
    expect(byRow.F.end).toBe('2026-11-10')
  })
})

function child(
  id: string,
  parentId: string,
  days: number,
  manualStart: string | null,
  percentComplete = 0,
): SchedRow {
  return { ...row(id, days, manualStart), parentId, percentComplete }
}

// A parent row with junk own values that must be ignored.
function parentRow(id: string, parentId: string | null = null): SchedRow {
  return { id, parentId, durationMinutes: 99 * DAY, elapsed: false, manualStart: '2020-01-01', percentComplete: 77 }
}

describe('schedule: parent rollups', () => {
  const C1 = child('C1', 'P', 2, '2026-11-09', 100) // 11-09 -> 11-10
  const C2 = child('C2', 'P', 3, '2026-11-11', 0) // 11-11 -> 11-13

  it('rolls start, end, working-day duration and weighted percent up from children', () => {
    const { byRow, errors } = schedule([parentRow('P'), C1, C2], [], defaultCalendar)
    expect(errors).toEqual([])
    expect(byRow.P).toEqual({ start: '2026-11-09', end: '2026-11-13', durationDays: 5, percentComplete: 40 })
  })

  it('counts only working days between start and end', () => {
    const F = child('F', 'P', 1, '2026-11-13', 0) // Friday
    const M = child('M', 'P', 1, '2026-11-16', 0) // Monday
    const { byRow } = schedule([parentRow('P'), F, M], [], defaultCalendar)
    expect(byRow.P).toMatchObject({ start: '2026-11-13', end: '2026-11-16', durationDays: 2 })
  })

  it('rolls nested parents up bottom-up', () => {
    const C3 = child('C3', 'G', 1, '2026-11-16', 100) // Monday
    const P = parentRow('P', 'G')
    const G = parentRow('G')
    // Input order puts the grandparent first to prove ordering does not depend on row order.
    const { byRow, errors } = schedule([G, C3, P, C1, C2], [], defaultCalendar)
    expect(errors).toEqual([])
    expect(byRow.P).toEqual({ start: '2026-11-09', end: '2026-11-13', durationDays: 5, percentComplete: 40 })
    // (5 * 40 + 1 * 100) / 6 = 50
    expect(byRow.G).toEqual({ start: '2026-11-09', end: '2026-11-16', durationDays: 6, percentComplete: 50 })
  })

  it('averages child percent when every child is a milestone', () => {
    const M1 = child('M1', 'P', 0, '2026-11-09', 100)
    const M2 = child('M2', 'P', 0, '2026-11-09', 50)
    const M3 = child('M3', 'P', 0, '2026-11-09', 0)
    const { byRow } = schedule([parentRow('P'), M1, M2, M3], [], defaultCalendar)
    expect(byRow.P).toEqual({ start: '2026-11-09', end: '2026-11-09', durationDays: 1, percentComplete: 50 })
  })

  it('ignores unscheduled children when rolling up', () => {
    const N = child('N', 'P', 4, null, 100) // no start -> not scheduled
    const { byRow, errors } = schedule([parentRow('P'), C1, N], [], defaultCalendar)
    expect(errors).toEqual([{ rowId: 'N', message: 'No start date' }])
    expect(byRow.P).toEqual({ start: '2026-11-09', end: '2026-11-10', durationDays: 2, percentComplete: 100 })
  })

  it('a parent with no scheduled children gets an error and no byRow entry', () => {
    const N = child('N', 'P', 4, null)
    const { byRow, errors } = schedule([parentRow('P'), N], [], defaultCalendar)
    expect(byRow.P).toBeUndefined()
    expect(errors).toContainEqual({ rowId: 'P', message: 'No scheduled children' })
  })

  it('a successor of a parent starts after the rolled-up end of the parent (FS)', () => {
    const S = row('S', 2)
    const { byRow, errors } = schedule([S, parentRow('P'), C1, C2], [dep('P', 'S')], defaultCalendar)
    expect(errors).toEqual([])
    expect(byRow.S.start).toBe('2026-11-16') // P ends Fri 11-13
    expect(byRow.S.end).toBe('2026-11-17')
  })

  it('a successor of a parent whose children cannot be scheduled is left out', () => {
    const N = child('N', 'P', 4, null)
    const { byRow, errors } = schedule([row('S', 2), parentRow('P'), N], [dep('P', 'S')], defaultCalendar)
    expect(byRow.S).toBeUndefined()
    expect(errors).toContainEqual({ rowId: 'S', message: 'Predecessor P could not be scheduled' })
  })

  it('a dependency whose successor is a parent is ignored and the parent gets an error', () => {
    const { byRow, errors } = schedule([A, parentRow('P'), C1, C2], [dep('A', 'P')], defaultCalendar)
    expect(errors).toEqual([{ rowId: 'P', message: 'Summary rows cannot have predecessors' }])
    expect(byRow.P).toEqual({ start: '2026-11-09', end: '2026-11-13', durationDays: 5, percentComplete: 40 })
  })

  it('a child depending on its own parent is a cycle, reported without hanging', () => {
    const D = child('D', 'P', 1, null)
    const { byRow, errors } = schedule([parentRow('P'), C1, D], [dep('P', 'D')], defaultCalendar)
    expect(byRow.P).toBeUndefined()
    expect(byRow.D).toBeUndefined()
    expect(byRow.C1).toBeDefined()
    for (const id of ['P', 'D']) {
      const e = errors.find((x) => x.rowId === id)
      expect(e?.message).toMatch(/^Dependency cycle: /)
    }
  })

  it('a child depending indirectly on its parent is a cycle', () => {
    const D = child('D', 'P', 1, null)
    const { byRow, errors } = schedule(
      [parentRow('P'), C1, D, row('S', 1)],
      [dep('P', 'S'), dep('S', 'D')],
      defaultCalendar,
    )
    expect(byRow.D).toBeUndefined()
    expect(byRow.S).toBeUndefined()
    expect(errors.filter((e) => e.message.startsWith('Dependency cycle: ')).map((e) => e.rowId).sort()).toEqual([
      'D',
      'P',
      'S',
    ])
  })

  it('rows that are each other ancestors do not hang or throw', () => {
    const r = schedule([parentRow('X', 'Y'), parentRow('Y', 'X')], [], defaultCalendar)
    expect(r.byRow).toEqual({})
    expect(r.errors.length).toBeGreaterThan(0)
  })
})

describe('schedule: cycle reporting', () => {
  it('a 2-cycle names its rows and a healthy unrelated row still schedules', () => {
    const rows = [row('H', 2, '2026-11-09'), row('X', 1), row('Y', 1)]
    const { byRow, errors } = schedule(rows, [dep('X', 'Y'), dep('Y', 'X')], defaultCalendar)
    expect(byRow.H).toEqual({ start: '2026-11-09', end: '2026-11-10', durationDays: 2, percentComplete: 0 })
    expect(byRow.X).toBeUndefined()
    expect(byRow.Y).toBeUndefined()
    expect(errors).toHaveLength(2)
    for (const id of ['X', 'Y']) {
      const msg = errors.find((e) => e.rowId === id)!.message
      expect(msg).toMatch(/^Dependency cycle: /)
      expect(msg).toContain('X')
      expect(msg).toContain('Y')
    }
  })

  it('a self-dependency is a cycle', () => {
    const { byRow, errors } = schedule([row('S', 1, '2026-11-09')], [dep('S', 'S')], defaultCalendar)
    expect(byRow.S).toBeUndefined()
    expect(errors).toEqual([{ rowId: 'S', message: 'Dependency cycle: S -> S' }])
  })

  it('rows downstream of a cycle get the downstream message', () => {
    const rows = [row('X', 1, '2026-11-09'), row('Y', 1), row('Z', 1), row('W', 1)]
    const deps = [dep('X', 'Y'), dep('Y', 'X'), dep('Y', 'Z'), dep('Z', 'W')]
    const { byRow, errors } = schedule(rows, deps, defaultCalendar)
    expect(byRow).toEqual({})
    expect(errors).toContainEqual({ rowId: 'Z', message: 'Depends on a row in a dependency cycle' })
    expect(errors).toContainEqual({ rowId: 'W', message: 'Depends on a row in a dependency cycle' })
    expect(errors.find((e) => e.rowId === 'X')!.message).toMatch(/^Dependency cycle: /)
  })
})
