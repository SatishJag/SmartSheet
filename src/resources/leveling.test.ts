import { describe, expect, it } from 'vitest'
import { buildLoad, overAllocatedDays } from './engine'
import { suggestLeveling } from './leveling'
import { assign, person, task } from './testkit'

const MON = '2026-11-16'
const WED = '2026-11-18'
const FRI = '2026-11-20'

const full = { kind: 'percent', value: 100 } as const
const floaty = (n: number) => ({ totalFloat: n, freeFloat: n, critical: false })

describe('suggestLeveling', () => {
  it('delays the task with float just far enough to clear the overlap, inside free float', () => {
    const tasks = [task('t1', MON, WED), task('t2', MON, WED, floaty(5))]
    const r = suggestLeveling([person('a')], [assign('1', 'a', 't1', full), assign('2', 'a', 't2', full)], tasks)
    expect(r.suggestions).toHaveLength(1)
    expect(r.suggestions[0]).toMatchObject({ rowId: 't2', shiftDays: 3, newStart: '2026-11-19', newEnd: '2026-11-23', resourceId: 'a', clearedDays: 3, knockOn: false })
    expect(r.unresolved).toEqual([])
  })

  it('never moves a critical task, and says what stays over-allocated', () => {
    const tasks = [task('t1', MON, WED), task('t2', MON, WED)]
    const r = suggestLeveling([person('a')], [assign('1', 'a', 't1', full), assign('2', 'a', 't2', full)], tasks)
    expect(r.suggestions).toEqual([])
    expect(r.unresolved).toEqual([{ resourceId: 'a', overDays: 3 }])
  })

  it('uses total float, flagged as knock-on, only when free float is not enough', () => {
    const tasks = [task('t1', MON, WED), task('t2', MON, WED, { totalFloat: 4, freeFloat: 1, critical: false })]
    const [s] = suggestLeveling([person('a')], [assign('1', 'a', 't1', full), assign('2', 'a', 't2', full)], tasks).suggestions
    expect(s).toMatchObject({ shiftDays: 3, knockOn: true })
  })

  it('does not suggest a delay beyond the float', () => {
    const tasks = [task('t1', MON, WED), task('t2', MON, WED, floaty(2))]
    const r = suggestLeveling([person('a')], [assign('1', 'a', 't1', full), assign('2', 'a', 't2', full)], tasks)
    expect(r.suggestions).toEqual([])
    expect(r.unresolved[0].resourceId).toBe('a')
  })

  it('does not create a new over-allocation: skips a delay that lands on another task', () => {
    // t3 sits Thu-Fri. t2 (Mon-Wed) delayed by 3 lands Thu-Mon and would collide with t3.
    const tasks = [task('t1', MON, WED), task('t2', MON, WED, floaty(8)), task('t3', '2026-11-19', FRI)]
    const r = suggestLeveling(
      [person('a')],
      [assign('1', 'a', 't1', full), assign('2', 'a', 't2', full), assign('3', 'a', 't3', full)],
      tasks,
    )
    expect(r.suggestions).toHaveLength(1)
    expect(r.suggestions[0]).toMatchObject({ rowId: 't2', shiftDays: 5, newStart: '2026-11-23' })
  })

  it('the moved task takes its other resources with it and is refused if they would get worse', () => {
    // t2 has a second resource b who is busy later (t4, critical); delaying t2 by 3 to 5 would overload b.
    const tasks = [task('t1', MON, WED), task('t2', MON, WED, floaty(8)), task('t4', '2026-11-19', '2026-11-23')]
    const assignments = [
      assign('1', 'a', 't1', full),
      assign('2', 'a', 't2', full),
      assign('3', 'b', 't2', full),
      assign('4', 'b', 't4', full),
    ]
    const r = suggestLeveling([person('a'), person('b')], assignments, tasks)
    expect(r.suggestions[0]).toMatchObject({ rowId: 't2', shiftDays: 6 }) // 5 would land on t4's Monday
  })

  it('leaves alone an assignment with its own dates', () => {
    const tasks = [task('t1', MON, WED), task('t2', MON, WED, floaty(9))]
    const r = suggestLeveling(
      [person('a')],
      [assign('1', 'a', 't1', full), assign('2', 'a', 't2', full, { startDate: MON, endDate: WED })],
      tasks,
    )
    expect(r.suggestions).toEqual([])
  })

  it('ignores tasks whose float is unknown', () => {
    const tasks = [task('t1', MON, WED), task('t2', MON, WED, { totalFloat: null, freeFloat: null, critical: false })]
    expect(suggestLeveling([person('a')], [assign('1', 'a', 't1', full), assign('2', 'a', 't2', full)], tasks).suggestions).toEqual([])
  })

  it('suggestions apply in sequence: the second sees the first', () => {
    const tasks = [task('t1', MON, WED), task('t2', MON, WED, floaty(20)), task('t3', MON, WED, floaty(20))]
    const as = [assign('1', 'a', 't1', full), assign('2', 'a', 't2', full), assign('3', 'a', 't3', full)]
    const r = suggestLeveling([person('a')], as, tasks)
    expect(r.suggestions.map((s) => s.rowId).sort()).toEqual(['t2', 't3'])
    expect(new Set(r.suggestions.map((s) => s.newStart)).size).toBe(2)
    expect(r.unresolved).toEqual([])
  })

  it('applying the suggestions really removes the over-allocation', () => {
    const tasks = [task('t1', MON, WED), task('t2', MON, WED, floaty(20)), task('t3', MON, WED, floaty(20))]
    const as = [assign('1', 'a', 't1', full), assign('2', 'a', 't2', full), assign('3', 'a', 't3', full)]
    const r = suggestLeveling([person('a')], as, tasks)
    const moved = tasks.map((t) => {
      const s = r.suggestions.find((x) => x.rowId === t.rowId)
      return s ? { ...t, start: s.newStart, end: s.newEnd } : t
    })
    expect(overAllocatedDays(buildLoad([person('a')], as, moved), 'a', MON, '2027-01-31')).toEqual([])
  })

  it('honours the resource filter, the date window and the suggestion cap', () => {
    const tasks = [task('t1', MON, WED), task('t2', MON, WED, floaty(20)), task('u1', MON, WED), task('u2', MON, WED, floaty(20))]
    const as = [assign('1', 'a', 't1', full), assign('2', 'a', 't2', full), assign('3', 'b', 'u1', full), assign('4', 'b', 'u2', full)]
    const rs = [person('a'), person('b')]
    expect(suggestLeveling(rs, as, tasks, { resourceIds: ['b'] }).suggestions.map((s) => s.rowId)).toEqual(['u2'])
    expect(suggestLeveling(rs, as, tasks, { from: '2027-01-01' }).suggestions).toEqual([])
    const capped = suggestLeveling(rs, as, tasks, { maxSuggestions: 1 })
    expect(capped.suggestions).toHaveLength(1)
    expect(capped.truncated).toBe(true)
  })

  it("uses the task's own sheet calendar: a delay skips that sheet's holidays", () => {
    const cal = { workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: ['2026-11-23'], hoursPerDay: 8 }
    const tasks = [task('t1', '2026-11-19', FRI), task('t2', '2026-11-19', FRI, { ...floaty(9), calendar: cal })]
    const [s] = suggestLeveling([person('a')], [assign('1', 'a', 't1', full), assign('2', 'a', 't2', full)], tasks).suggestions
    // The task is 2 days (Thu-Fri); the earliest clean start is the next working day of its calendar after Fri, which is
    // Tue 24 (Mon 23 is a holiday), a delay of 2 working days.
    expect(s).toMatchObject({ shiftDays: 2, newStart: '2026-11-24' })
  })
})
