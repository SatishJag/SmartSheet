import { describe, expect, it } from 'vitest'
import { compareToBaseline, snapshotSchedule, type Baseline } from './baseline'
import { defaultCalendar } from './calendar'
import { schedule, type SchedDep, type SchedRow } from './schedule'

const DAY = 8 * 60
const row = (id: string, days: number, manualStart: string | null = null, parentId: string | null = null): SchedRow => ({
  id,
  parentId,
  durationMinutes: days * DAY,
  elapsed: false,
  manualStart,
  percentComplete: 0,
})
const fs = (a: string, b: string): SchedDep => ({ predecessorId: a, successorId: b, type: 'FS', lagMinutes: 0 })

// 2026-11-09 is a Monday.
function planned() {
  const rows = [row('A', 3, '2026-11-09'), row('B', 2)]
  const deps = [fs('A', 'B')]
  return { rows, deps, result: schedule(rows, deps, defaultCalendar) }
}

function baselineOf(result: ReturnType<typeof schedule>): Baseline {
  return { id: 'b1', slot: 1, name: 'Contract baseline', createdAt: '2026-11-09T08:00:00Z', rows: snapshotSchedule(result) }
}

describe('snapshotSchedule', () => {
  it('records start, end and working-day duration for every scheduled row', () => {
    const { result } = planned()
    expect(snapshotSchedule(result)).toEqual([
      { rowId: 'A', start: '2026-11-09', end: '2026-11-11', durationDays: 3 },
      { rowId: 'B', start: '2026-11-12', end: '2026-11-13', durationDays: 2 },
    ])
  })

  it('leaves out rows the scheduler could not place', () => {
    const rows = [row('A', 1, '2026-11-09'), row('X', 1)] // X has no start
    expect(snapshotSchedule(schedule(rows, [], defaultCalendar)).map((r) => r.rowId)).toEqual(['A'])
  })

  it('includes summary rows (their rolled-up dates)', () => {
    const rows = [row('P', 0), row('A', 3, '2026-11-09', 'P')]
    expect(snapshotSchedule(schedule(rows, [], defaultCalendar)).map((r) => r.rowId).sort()).toEqual(['A', 'P'])
  })
})

describe('compareToBaseline', () => {
  it('an unchanged schedule is on track everywhere with zero variance', () => {
    const { result } = planned()
    const cmp = compareToBaseline(defaultCalendar, result, baselineOf(result))
    expect(cmp.byRow.A).toEqual({ startVariance: 0, finishVariance: 0, durationVariance: 0, status: 'on-track' })
    expect(cmp.byRow.B.status).toBe('on-track')
    expect(cmp.projectFinishVariance).toBe(0)
    expect(cmp.removedRowIds).toEqual([])
  })

  it('a longer task makes itself and its successor late, in working days', () => {
    const { rows, deps, result } = planned()
    const baseline = baselineOf(result)
    const slipped = schedule(rows.map((r) => (r.id === 'A' ? { ...r, durationMinutes: 5 * DAY } : r)), deps, defaultCalendar)
    const cmp = compareToBaseline(defaultCalendar, slipped, baseline)
    // A: ends Fri 11-13 instead of Wed 11-11 = 2 working days late, 2 days longer, same start.
    expect(cmp.byRow.A).toEqual({ startVariance: 0, finishVariance: 2, durationVariance: 2, status: 'late' })
    // B: starts Mon 11-16 instead of Thu 11-12 (2 working days), ends Tue 11-17 instead of Fri 11-13 (2).
    expect(cmp.byRow.B).toEqual({ startVariance: 2, finishVariance: 2, durationVariance: 0, status: 'late' })
    expect(cmp.projectFinishVariance).toBe(2)
  })

  it('counts working days only: a slip across a weekend is not inflated by it', () => {
    const baseline: Baseline = { id: 'b', slot: 1, name: 'x', createdAt: '', rows: [{ rowId: 'A', start: '2026-11-09', end: '2026-11-13', durationDays: 5 }] }
    const result = schedule([row('A', 5, '2026-11-16')], [], defaultCalendar) // a week later, Mon-Fri
    expect(compareToBaseline(defaultCalendar, result, baseline).byRow.A).toMatchObject({ startVariance: 5, finishVariance: 5 })
  })

  it('a task finishing earlier is ahead, with negative variance', () => {
    const { rows, deps, result } = planned()
    const baseline = baselineOf(result)
    const faster = schedule(rows.map((r) => (r.id === 'A' ? { ...r, durationMinutes: 2 * DAY } : r)), deps, defaultCalendar)
    const cmp = compareToBaseline(defaultCalendar, faster, baseline)
    expect(cmp.byRow.A).toEqual({ startVariance: 0, finishVariance: -1, durationVariance: -1, status: 'ahead' })
    expect(cmp.projectFinishVariance).toBe(-1)
  })

  it('a row added since the baseline is new, a row deleted since is reported as removed', () => {
    const { result } = planned()
    const baseline = baselineOf(result)
    const now = schedule([row('A', 3, '2026-11-09'), row('C', 1, '2026-11-12')], [], defaultCalendar) // B gone, C added
    const cmp = compareToBaseline(defaultCalendar, now, baseline)
    expect(cmp.byRow.C).toEqual({ startVariance: null, finishVariance: null, durationVariance: null, status: 'new' })
    expect(cmp.removedRowIds).toEqual(['B'])
    expect(cmp.byRow.B).toBeUndefined()
  })

  it('the project finish variance compares the latest end then and now, not any one row', () => {
    const { result } = planned() // finish Fri 11-13
    const baseline = baselineOf(result)
    const now = schedule([row('A', 3, '2026-11-09'), row('B', 2, '2026-11-12'), row('Z', 1, '2026-11-17')], [], defaultCalendar)
    expect(compareToBaseline(defaultCalendar, now, baseline).projectFinishVariance).toBe(2) // Tue 11-17 vs Fri 11-13
  })

  it('an empty baseline or schedule gives no project variance and does not throw', () => {
    const empty = schedule([], [], defaultCalendar)
    const cmp = compareToBaseline(defaultCalendar, empty, { id: 'b', slot: 1, name: 'n', createdAt: '', rows: [] })
    expect(cmp).toEqual({ byRow: {}, removedRowIds: [], projectFinishVariance: null })
  })

  it('works over non-working dates (a holiday) and for dates that are not working days', () => {
    const cal = { ...defaultCalendar, nonWorkingDates: ['2026-11-12'] }
    const baseline: Baseline = { id: 'b', slot: 1, name: 'x', createdAt: '', rows: [{ rowId: 'A', start: '2026-11-11', end: '2026-11-11', durationDays: 1 }] }
    const result = schedule([row('A', 1, '2026-11-13')], [], cal) // Wed 11-11 -> Fri 11-13, 12th is a holiday
    expect(compareToBaseline(cal, result, baseline).byRow.A.finishVariance).toBe(1)
  })
})
