import { describe, expect, it } from 'vitest'
import type { Calendar } from '../engine/types'
import { COL, fsDep, makeRow, makeSheetData, makeTestStore } from '../test/fixtures'
import { isStartDriven, type SheetState } from './sheetStore'
import { normalizeCalendar } from './sheetSettings'
import type { StoreApi } from 'zustand/vanilla'

// Fixture: Mon-Fri, 8h. r-survey 2026-11-09 (Mon) 2d; r-clear 3d FS after it; r-found 5d FS after r-clear.
const MON_FRI: Calendar = { workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 }

async function settled(store: StoreApi<SheetState>, status: SheetState['saveStatus'] = 'saved') {
  for (let i = 0; i < 50 && store.getState().saveStatus !== status; i++) await new Promise((r) => setTimeout(r, 0))
  expect(store.getState().saveStatus).toBe(status)
}

const sched = (store: StoreApi<SheetState>, id: string) => store.getState().scheduled.byRow[id]

describe('normalizeCalendar', () => {
  it('dedupes and sorts weekdays and dates', () => {
    expect(
      normalizeCalendar({ workingWeekdays: [5, 1, 3, 1], nonWorkingDates: ['2026-12-25', '2026-01-01', '2026-12-25'], hoursPerDay: 7.5 }),
    ).toEqual({ ok: true, calendar: { workingWeekdays: [1, 3, 5], nonWorkingDates: ['2026-01-01', '2026-12-25'], hoursPerDay: 7.5 } })
  })

  it('requires at least one working weekday', () => {
    expect(normalizeCalendar({ ...MON_FRI, workingWeekdays: [] })).toEqual({ ok: false, error: 'Choose at least one working day of the week' })
  })

  it('rejects weekdays outside 0..6', () => {
    expect(normalizeCalendar({ ...MON_FRI, workingWeekdays: [1, 7] }).ok).toBe(false)
    expect(normalizeCalendar({ ...MON_FRI, workingWeekdays: [1.5] }).ok).toBe(false)
  })

  it.each([0, 0.5, 25, Number.NaN, Infinity, 7.123])('rejects hoursPerDay %s', (h) => {
    expect(normalizeCalendar({ ...MON_FRI, hoursPerDay: h })).toEqual({
      ok: false,
      error: 'Hours per day must be between 1 and 24 (in whole minutes)',
    })
  })

  it.each([1, 24, 7.5, 8])('accepts hoursPerDay %s', (h) => {
    expect(normalizeCalendar({ ...MON_FRI, hoursPerDay: h }).ok).toBe(true)
  })

  it.each(['2026-02-30', '26-01-01', '1969-12-31', '2101-01-01', 'soon'])('rejects non-working date %s', (d) => {
    const r = normalizeCalendar({ ...MON_FRI, nonWorkingDates: [d] })
    expect(r).toEqual({ ok: false, error: `"${d}" is not a valid date between 1970-01-01 and 2100-12-31` })
  })
})

describe('setCalendar', () => {
  it('re-runs the schedule: a new non-working date pushes dependency-driven rows out', async () => {
    const { store } = await makeTestStore()
    expect(sched(store, 'r-clear')).toMatchObject({ start: '2026-11-11', end: '2026-11-13' })
    expect(store.getState().setCalendar({ ...MON_FRI, nonWorkingDates: ['2026-11-11'] })).toEqual({ ok: true })
    expect(store.getState().data!.sheet.calendar.nonWorkingDates).toEqual(['2026-11-11'])
    expect(sched(store, 'r-clear')).toMatchObject({ start: '2026-11-12', end: '2026-11-16' })
    expect(sched(store, 'r-found')).toMatchObject({ start: '2026-11-17', end: '2026-11-23' })
  })

  it('a typed start on what is now a non-working day moves to the next working day', async () => {
    const { store } = await makeTestStore()
    // Monday is no longer a working day.
    store.getState().setCalendar({ ...MON_FRI, workingWeekdays: [2, 3, 4, 5] })
    expect(sched(store, 'r-survey')).toMatchObject({ start: '2026-11-10', end: '2026-11-11' })
    // The typed value itself is kept.
    expect(store.getState().data!.rows.find((r) => r.id === 'r-survey')!.cells[COL.start]).toBe('2026-11-09')
  })

  it('stores the normalised calendar and saves it with the dependencies flag', async () => {
    const { store, persistence } = await makeTestStore()
    store.getState().setCalendar({ workingWeekdays: [6, 1, 2], nonWorkingDates: ['2026-12-25', '2026-12-24'], hoursPerDay: 10 })
    const calendar = { workingWeekdays: [1, 2, 6], nonWorkingDates: ['2026-12-24', '2026-12-25'], hoursPerDay: 10 }
    expect(store.getState().data!.sheet.calendar).toEqual(calendar)
    await settled(store)
    expect(persistence.saveSheetSettings).toHaveBeenCalledWith('sheet-1', { calendar, dependenciesEnabled: true })
  })

  it('rejects an invalid calendar and changes nothing', async () => {
    const { store, persistence } = await makeTestStore()
    const before = store.getState().data
    expect(store.getState().setCalendar({ ...MON_FRI, workingWeekdays: [] })).toEqual({
      ok: false,
      error: 'Choose at least one working day of the week',
    })
    expect(store.getState().data).toBe(before)
    await settled(store)
    expect(persistence.saveSheetSettings).not.toHaveBeenCalled()
  })

  it('an unchanged calendar saves nothing', async () => {
    const { store, persistence } = await makeTestStore()
    expect(store.getState().setCalendar({ ...MON_FRI, workingWeekdays: [5, 4, 3, 2, 1] })).toEqual({ ok: true })
    await settled(store)
    expect(persistence.saveSheetSettings).not.toHaveBeenCalled()
  })

  it('a failed save retries, counts as failed, keeps the change, and recovers on retryFailed', async () => {
    const { store, persistence } = await makeTestStore()
    persistence.saveSheetSettings.mockRejectedValue(new Error('offline'))
    store.getState().setCalendar({ ...MON_FRI, hoursPerDay: 10 })
    await settled(store, 'failed')
    expect(persistence.saveSheetSettings).toHaveBeenCalledTimes(4) // first try + 3 retries
    expect(store.getState().failedCount).toBe(1)
    expect(store.getState().data!.sheet.calendar.hoursPerDay).toBe(10)

    persistence.saveSheetSettings.mockResolvedValue(undefined)
    store.getState().retryFailed()
    await settled(store)
    expect(store.getState().failedCount).toBe(0)
    expect(persistence.saveSheetSettings).toHaveBeenLastCalledWith('sheet-1', {
      calendar: { ...MON_FRI, hoursPerDay: 10 },
      dependenciesEnabled: true,
    })
  })

  it('is refused before the sheet is loaded', async () => {
    const { store } = await makeTestStore()
    store.setState({ data: null })
    expect(store.getState().setCalendar(MON_FRI)).toEqual({ ok: false, error: 'Sheet is not loaded' })
  })
})

describe('setDependenciesEnabled', () => {
  it('turning off keeps the dependencies but stops them driving dates', async () => {
    const { store, persistence } = await makeTestStore()
    expect(store.getState().setDependenciesEnabled(false)).toEqual({ ok: true })
    const data = store.getState().data!
    expect(data.sheet.dependenciesEnabled).toBe(false)
    expect(data.dependencies).toHaveLength(2)
    expect(isStartDriven(data, 'r-clear')).toBe(false)
    // r-clear has no Start of its own, so it is no longer scheduled.
    expect(sched(store, 'r-clear')).toBeUndefined()
    expect(store.getState().scheduled.errors).toContainEqual({ rowId: 'r-clear', message: 'No start date' })
    await settled(store)
    expect(persistence.saveSheetSettings).toHaveBeenCalledWith('sheet-1', { calendar: MON_FRI, dependenciesEnabled: false })
  })

  it('turning off clears the "set by predecessors" error and lets a Start be typed', async () => {
    const { store } = await makeTestStore()
    expect(store.getState().setCell('r-clear', COL.start, '2026-11-16').ok).toBe(false)
    expect(store.getState().errors).toHaveLength(1)
    store.getState().setDependenciesEnabled(false)
    expect(store.getState().errors).toEqual([])
    expect(store.getState().setCell('r-clear', COL.start, '2026-11-16')).toEqual({ ok: true })
    expect(sched(store, 'r-clear')).toMatchObject({ start: '2026-11-16', end: '2026-11-18' })
  })

  it('turning back on drives dates from the kept dependencies again', async () => {
    const { store, persistence } = await makeTestStore()
    store.getState().setDependenciesEnabled(false)
    expect(store.getState().setDependenciesEnabled(true)).toEqual({ ok: true })
    expect(sched(store, 'r-clear')).toMatchObject({ start: '2026-11-11', end: '2026-11-13' })
    await settled(store)
    expect(persistence.saveSheetSettings).toHaveBeenLastCalledWith('sheet-1', { calendar: MON_FRI, dependenciesEnabled: true })
  })

  it('an unchanged flag saves nothing', async () => {
    const { store, persistence } = await makeTestStore()
    expect(store.getState().setDependenciesEnabled(true)).toEqual({ ok: true })
    await settled(store)
    expect(persistence.saveSheetSettings).not.toHaveBeenCalled()
  })

  it('refuses to turn on while a schedule column holds a formula, naming the column and row', async () => {
    const data = makeSheetData({ sheet: { ...makeSheetData().sheet, dependenciesEnabled: false } })
    const { store, persistence } = await makeTestStore(data)
    expect(store.getState().setCell('r-found', COL.duration, '=2+3')).toEqual({ ok: true }) // allowed while off
    const result = store.getState().setDependenciesEnabled(true)
    expect(result).toEqual({
      ok: false,
      error: 'Remove the formula in Duration (row 4) first: formulas are not allowed in schedule columns when dependencies are on',
    })
    expect(store.getState().data!.sheet.dependenciesEnabled).toBe(false)
    await settled(store)
    expect(persistence.saveSheetSettings).not.toHaveBeenCalled()
  })

  it('allows turning on with formulas in other columns', async () => {
    const data = makeSheetData({ sheet: { ...makeSheetData().sheet, dependenciesEnabled: false } })
    const { store } = await makeTestStore(data)
    store.getState().setCell('r-found', COL.task, '=1+1')
    expect(store.getState().setDependenciesEnabled(true)).toEqual({ ok: true })
  })

  it('refuses to turn on when a summary row has predecessors (made while dependencies were off)', async () => {
    // r-b depends on r-a; r-c was then made a child of r-b while dependencies were off.
    const data = makeSheetData({
      sheet: { ...makeSheetData().sheet, dependenciesEnabled: false },
      rows: [
        makeRow('r-a', 'a0', { [COL.task]: 'A', [COL.start]: '2026-11-09' }),
        makeRow('r-b', 'a1', { [COL.task]: 'B' }),
        makeRow('r-c', 'a0', { [COL.task]: 'C', [COL.start]: '2026-11-09' }, 'r-b'),
      ],
      dependencies: [fsDep('r-a', 'r-b')],
    })
    const { store } = await makeTestStore(data)
    expect(store.getState().setDependenciesEnabled(true)).toEqual({
      ok: false,
      error: "Can't turn on dependencies: row 2 is a summary row with predecessors; remove them first",
    })
  })

  it('refuses to turn on when a task would depend on its own parent or sub-task', async () => {
    const data = makeSheetData({
      sheet: { ...makeSheetData().sheet, dependenciesEnabled: false },
      rows: [
        makeRow('r-p', 'a0', { [COL.task]: 'Parent' }),
        makeRow('r-k', 'a0', { [COL.task]: 'Kid', [COL.start]: '2026-11-09' }, 'r-p'),
        makeRow('r-x', 'a1', { [COL.task]: 'Other', [COL.start]: '2026-11-09' }),
      ],
      // The parent drives its own child.
      dependencies: [fsDep('r-p', 'r-k')],
    })
    const { store } = await makeTestStore(data)
    const r = store.getState().setDependenciesEnabled(true)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/^Can't turn on dependencies: A task cannot depend on its own parent or sub-task/)
  })
})
