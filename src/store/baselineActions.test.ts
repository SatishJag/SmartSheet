import { describe, expect, it } from 'vitest'
import type { BaselineMeta, BaselineRow } from '../engine/baseline'
import { COL, fixtureColumns, fsDep, makeRow, makeSheetData, makeTestStore } from '../test/fixtures'
import { baselineComparison } from './baselineActions'

const meta = (slot: number, name = `B${slot}`): BaselineMeta => ({ id: `bl-${slot}`, slot, name, createdAt: '2026-11-01T00:00:00.000Z' })
const frozen = (rowId: string, start: string, end: string, durationDays: number): BaselineRow => ({ rowId, start, end, durationDays })

describe('saveBaseline', () => {
  it('snapshots the schedule, stores it through persistence and caches the rows', async () => {
    const { store, persistence } = await makeTestStore()
    const scheduled = store.getState().scheduled
    const res = await store.getState().saveBaseline(1, '  Agreed plan  ')
    expect(res).toEqual({ ok: true })

    expect(persistence.saveBaseline).toHaveBeenCalledTimes(1)
    const [sheetId, slot, name, rows] = persistence.saveBaseline.mock.calls[0]
    expect([sheetId, slot, name]).toEqual(['sheet-1', 1, 'Agreed plan'])
    expect(rows.map((r) => r.rowId).sort()).toEqual(Object.keys(scheduled.byRow).sort())
    expect(rows.find((r) => r.rowId === 'r-survey')).toEqual({
      rowId: 'r-survey',
      start: scheduled.byRow['r-survey'].start,
      end: scheduled.byRow['r-survey'].end,
      durationDays: scheduled.byRow['r-survey'].durationDays,
    })

    const s = store.getState()
    expect(s.data!.baselines).toEqual([{ id: expect.any(String), slot: 1, name: 'Agreed plan', createdAt: expect.any(String) }])
    expect(s.baselineRows[s.data!.baselines![0].id]).toEqual(rows)
    expect(s.notices).toEqual(['Saved baseline "Agreed plan" in slot 1 (4 rows).'])
  })

  it('replaces the baseline in a used slot (header and cached rows) and keeps others ordered by slot', async () => {
    const { store, persistence } = await makeTestStore(makeSheetData({ baselines: [meta(1), meta(4)] }))
    persistence.loadBaselineRows.mockResolvedValue([frozen('r-found', '2026-11-01', '2026-11-02', 2)])
    await store.getState().loadBaselineRows('bl-4')
    expect(store.getState().baselineRows['bl-4']).toHaveLength(1)

    expect((await store.getState().saveBaseline(4, 'Replacement')).ok).toBe(true)
    const s = store.getState()
    expect(s.data!.baselines!.map((b) => [b.slot, b.name])).toEqual([
      [1, 'B1'],
      [4, 'Replacement'],
    ])
    expect(Object.keys(s.baselineRows)).toEqual([s.data!.baselines![1].id])
    expect(s.baselineRows['bl-4']).toBeUndefined()

    await store.getState().saveBaseline(2, 'Between')
    expect(store.getState().data!.baselines!.map((b) => b.slot)).toEqual([1, 2, 4])
  })

  it('validates the slot and the name without calling persistence', async () => {
    const { store, persistence } = await makeTestStore()
    for (const slot of [0, 6, 1.5, NaN, -1]) {
      const res = await store.getState().saveBaseline(slot, 'x')
      expect(res.ok).toBe(false)
    }
    for (const name of ['', '   ', 'n'.repeat(101)]) {
      const res = await store.getState().saveBaseline(1, name)
      expect(res).toEqual({ ok: false, error: 'Baseline name must be 1 to 100 characters' })
    }
    expect((await store.getState().saveBaseline(1, 'n'.repeat(100))).ok).toBe(true)
    expect(persistence.saveBaseline).toHaveBeenCalledTimes(1)
  })

  it('refuses when no row is scheduled', async () => {
    const noStart = makeSheetData({ columns: fixtureColumns.filter((c) => c.role !== 'start') })
    const { store, persistence } = await makeTestStore(noStart)
    expect(store.getState().scheduled.byRow).toEqual({})
    const res = await store.getState().saveBaseline(1, 'Plan')
    expect(res).toEqual({ ok: false, error: 'Nothing to baseline yet: no task has scheduled dates' })
    expect(persistence.saveBaseline).not.toHaveBeenCalled()
    expect(store.getState().notices).toEqual([])
  })

  it('saves the scheduled rows and says how many were left out when some cannot be scheduled', async () => {
    const data = makeSheetData({
      rows: [
        makeRow('r-ok', 'a0', { [COL.task]: 'Fine', [COL.start]: '2026-11-09', [COL.duration]: '2d' }),
        makeRow('r-a', 'a1', { [COL.task]: 'A', [COL.duration]: '1d' }),
        makeRow('r-b', 'a2', { [COL.task]: 'B', [COL.duration]: '1d' }),
      ],
      dependencies: [fsDep('r-a', 'r-b'), fsDep('r-b', 'r-a')],
    })
    const { store, persistence } = await makeTestStore(data)
    const scheduledIds = Object.keys(store.getState().scheduled.byRow)
    expect(scheduledIds).toContain('r-ok')
    const leftOut = 3 - scheduledIds.length
    expect(leftOut).toBeGreaterThan(0) // the cycle leaves rows out

    const res = await store.getState().saveBaseline(1, 'Partial')
    expect(res).toEqual({ ok: true })
    expect(persistence.saveBaseline.mock.calls[0][3].map((r) => r.rowId).sort()).toEqual(scheduledIds.sort())
    const notice = store.getState().notices[0]
    expect(notice).toContain('Saved baseline "Partial" in slot 1')
    expect(notice).toContain(`${leftOut} row${leftOut === 1 ? '' : 's'} could not be scheduled`)
  })

  it('on failure returns the error and leaves the state unchanged', async () => {
    const { store, persistence } = await makeTestStore(makeSheetData({ baselines: [meta(2)] }))
    persistence.saveBaseline.mockRejectedValueOnce(new Error('network down'))
    const before = store.getState()
    const res = await store.getState().saveBaseline(2, 'Nope')
    expect(res).toEqual({ ok: false, error: 'network down' })
    const after = store.getState()
    expect(after.data).toBe(before.data)
    expect(after.baselineRows).toBe(before.baselineRows)
    expect(after.notices).toEqual([])
    // and a retry works
    expect((await store.getState().saveBaseline(2, 'Nope')).ok).toBe(true)
  })

  it('does not touch the cell save status or queue', async () => {
    const { store, persistence } = await makeTestStore()
    persistence.saveBaseline.mockRejectedValueOnce(new Error('boom'))
    await store.getState().saveBaseline(1, 'A')
    expect(store.getState().saveStatus).toBe('saved')
    expect(store.getState().failedCount).toBe(0)
    await store.getState().saveBaseline(1, 'A')
    expect(store.getState().saveStatus).toBe('saved')
    expect(persistence.saveCell).not.toHaveBeenCalled()
    expect(persistence.insertRow).not.toHaveBeenCalled()
  })

  it('refuses a second save while one is in flight', async () => {
    const { store, persistence } = await makeTestStore()
    let release!: () => void
    persistence.saveBaseline.mockImplementationOnce(
      (_s, slot, name) => new Promise<BaselineMeta>((r) => (release = () => r({ id: 'x', slot, name, createdAt: 't' }))),
    )
    const first = store.getState().saveBaseline(1, 'A')
    const second = await store.getState().saveBaseline(1, 'B')
    expect(second.ok).toBe(false)
    release()
    expect((await first).ok).toBe(true)
    expect(persistence.saveBaseline).toHaveBeenCalledTimes(1)
    expect((await store.getState().saveBaseline(2, 'C')).ok).toBe(true)
  })

  it('does not write into a sheet that was replaced while saving', async () => {
    const { store, persistence } = await makeTestStore()
    let release!: () => void
    persistence.saveBaseline.mockImplementationOnce(
      (_s, slot, name) => new Promise<BaselineMeta>((r) => (release = () => r({ id: 'x', slot, name, createdAt: 't' }))),
    )
    const pending = store.getState().saveBaseline(1, 'A')
    persistence.loadSheet.mockResolvedValueOnce(makeSheetData({ sheet: { ...makeSheetData().sheet, id: 'sheet-2' } }))
    await store.getState().load('sheet-2')
    release()
    expect(await pending).toEqual({ ok: true })
    expect(store.getState().data!.baselines ?? []).toEqual([])
    expect(store.getState().baselineRows).toEqual({})
  })
})

describe('deleteBaseline', () => {
  it('deletes through persistence, then removes the header and cached rows', async () => {
    const { store, persistence } = await makeTestStore(makeSheetData({ baselines: [meta(1), meta(2)] }))
    persistence.loadBaselineRows.mockResolvedValue([frozen('r-found', '2026-11-01', '2026-11-02', 2)])
    await store.getState().loadBaselineRows('bl-1')
    expect(await store.getState().deleteBaseline('bl-1')).toEqual({ ok: true })
    expect(persistence.deleteBaseline).toHaveBeenCalledWith('bl-1')
    expect(store.getState().data!.baselines).toEqual([meta(2)])
    expect(store.getState().baselineRows).toEqual({})
    expect(store.getState().notices).toEqual(['Deleted baseline "B1".'])
  })

  it('on failure returns the error and leaves the state unchanged', async () => {
    const { store, persistence } = await makeTestStore(makeSheetData({ baselines: [meta(1)] }))
    persistence.deleteBaseline.mockRejectedValueOnce(new Error('denied'))
    const before = store.getState()
    expect(await store.getState().deleteBaseline('bl-1')).toEqual({ ok: false, error: 'denied' })
    expect(store.getState().data).toBe(before.data)
    expect(store.getState().notices).toEqual([])
  })

  it('refuses an unknown baseline without calling persistence', async () => {
    const { store, persistence } = await makeTestStore()
    expect((await store.getState().deleteBaseline('nope')).ok).toBe(false)
    expect(persistence.deleteBaseline).not.toHaveBeenCalled()
  })
})

describe('loadBaselineRows', () => {
  it('fetches once, then serves the cache; concurrent calls share one fetch', async () => {
    const { store, persistence } = await makeTestStore(makeSheetData({ baselines: [meta(1)] }))
    const rows = [frozen('r-found', '2026-11-01', '2026-11-02', 2)]
    persistence.loadBaselineRows.mockResolvedValue(rows)
    const [a, b] = await Promise.all([store.getState().loadBaselineRows('bl-1'), store.getState().loadBaselineRows('bl-1')])
    expect([a, b]).toEqual([{ ok: true }, { ok: true }])
    expect(await store.getState().loadBaselineRows('bl-1')).toEqual({ ok: true })
    expect(persistence.loadBaselineRows).toHaveBeenCalledTimes(1)
    expect(store.getState().baselineRows['bl-1']).toEqual(rows)
  })

  it('returns the error on failure, caches nothing, and can be retried', async () => {
    const { store, persistence } = await makeTestStore(makeSheetData({ baselines: [meta(1)] }))
    persistence.loadBaselineRows.mockRejectedValueOnce(new Error('slow network'))
    expect(await store.getState().loadBaselineRows('bl-1')).toEqual({ ok: false, error: 'slow network' })
    expect(store.getState().baselineRows).toEqual({})
    expect(await store.getState().loadBaselineRows('bl-1')).toEqual({ ok: true })
    expect(store.getState().baselineRows['bl-1']).toEqual([])
  })

  it('refuses an unknown baseline', async () => {
    const { store, persistence } = await makeTestStore()
    expect((await store.getState().loadBaselineRows('nope')).ok).toBe(false)
    expect(persistence.loadBaselineRows).not.toHaveBeenCalled()
  })

  it('load() resets the cache', async () => {
    const { store, persistence } = await makeTestStore(makeSheetData({ baselines: [meta(1)] }))
    await store.getState().loadBaselineRows('bl-1')
    expect(Object.keys(store.getState().baselineRows)).toEqual(['bl-1'])
    await store.getState().load('sheet-1')
    expect(store.getState().baselineRows).toEqual({})
    expect(persistence.loadSheet).toHaveBeenCalledTimes(2)
  })
})

describe('baselineComparison', () => {
  it('is null until the rows are loaded, then compares the live schedule with the baseline', async () => {
    const { store, persistence } = await makeTestStore(makeSheetData({ baselines: [meta(1)] }))
    expect(baselineComparison(store.getState(), 'bl-1')).toBeNull()
    expect(baselineComparison(store.getState(), 'unknown')).toBeNull()

    const now = store.getState().scheduled.byRow
    persistence.loadBaselineRows.mockResolvedValue([
      // r-survey: same dates as now; r-found: planned a working day earlier; r-gone: deleted since.
      frozen('r-survey', now['r-survey'].start, now['r-survey'].end, now['r-survey'].durationDays),
      frozen('r-found', '2026-11-09', '2026-11-10', now['r-found'].durationDays),
      frozen('r-gone', '2026-11-09', '2026-11-09', 1),
    ])
    await store.getState().loadBaselineRows('bl-1')
    const cmp = baselineComparison(store.getState(), 'bl-1')!
    expect(cmp.byRow['r-survey'].status).toBe('on-track')
    expect(cmp.byRow['r-found'].status).toBe('late')
    expect(cmp.byRow['r-found'].finishVariance).toBeGreaterThan(0)
    expect(cmp.byRow['r-clear'].status).toBe('new')
    expect(cmp.removedRowIds).toEqual(['r-gone'])
  })

  it('returns the same object until the schedule changes', async () => {
    const { store } = await makeTestStore(makeSheetData({ baselines: [meta(1)] }))
    await store.getState().loadBaselineRows('bl-1')
    const a = baselineComparison(store.getState(), 'bl-1')
    expect(baselineComparison(store.getState(), 'bl-1')).toBe(a)
    store.getState().setCell('r-survey', COL.duration, '4d')
    const b = baselineComparison(store.getState(), 'bl-1')
    expect(b).not.toBe(a)
  })
})
