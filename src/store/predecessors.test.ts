import { describe, expect, it } from 'vitest'
import { COL, fsDep, makeRow, makeSheetData } from '../test/fixtures'
import { parsePredecessorInput, predecessorString, predecessorStrings, predecessorTooltip } from './predecessors'

// Fixture tree order: 1 r-site (parent), 2 r-survey, 3 r-clear, 4 r-found.

describe('predecessorString', () => {
  it('formats a row\'s incoming dependencies by row number', () => {
    const data = makeSheetData()
    expect(predecessorString(data, 'r-clear')).toBe('2FS')
    expect(predecessorString(data, 'r-found')).toBe('3FS')
  })

  it('is empty for a row without predecessors', () => {
    expect(predecessorString(makeSheetData(), 'r-survey')).toBe('')
  })

  it('sorts by predecessor row number and formats lag and lead', () => {
    const data = makeSheetData({
      dependencies: [
        { predecessorId: 'r-clear', successorId: 'r-found', type: 'SS', lagMinutes: -480 },
        { predecessorId: 'r-site', successorId: 'r-found', type: 'FF', lagMinutes: 0 },
        { predecessorId: 'r-survey', successorId: 'r-found', type: 'FS', lagMinutes: 3 * 480 + 240 },
      ],
    })
    expect(predecessorString(data, 'r-found')).toBe('1FF, 2FS +3d 4h, 3SS -1d')
  })

  it('uses the sheet calendar hours per day', () => {
    const data = makeSheetData({ dependencies: [{ predecessorId: 'r-survey', successorId: 'r-clear', type: 'FS', lagMinutes: 600 }] })
    data.sheet.calendar = { ...data.sheet.calendar, hoursPerDay: 10 }
    expect(predecessorString(data, 'r-clear')).toBe('2FS +1d')
  })

  it('predecessorStrings gives the same text for every row in one pass', () => {
    const data = makeSheetData()
    const all = predecessorStrings(data)
    for (const r of data.rows) expect(all.get(r.id) ?? '').toBe(predecessorString(data, r.id))
    expect(all.get('r-found')).toBe('3FS')
  })

  it('ignores any stored cell value for the predecessor column', () => {
    const data = makeSheetData({ dependencies: [] })
    data.rows = data.rows.map((r) => ({ ...r, cells: { ...r.cells, [COL.predecessors]: '1' } }))
    expect(predecessorString(data, 'r-clear')).toBe('')
  })
})

describe('predecessorTooltip', () => {
  it('lists each predecessor as "<number>: <name>", falling back to "Row <n>"', () => {
    const data = makeSheetData({ dependencies: [fsDep('r-survey', 'r-found'), fsDep('r-x', 'r-found')] })
    data.rows.push(makeRow('r-x', 'a2', {}))
    expect(predecessorTooltip(data, 'r-found')).toBe('2: Survey\n5: Row 5')
    expect(predecessorTooltip(data, 'r-survey')).toBe('')
  })
})

describe('parsePredecessorInput', () => {
  const data = makeSheetData()

  it('turns row numbers into dependencies for the successor', () => {
    expect(parsePredecessorInput(data, 'r-found', '2FS +1d, 1ss')).toEqual({
      ok: true,
      deps: [
        { predecessorId: 'r-survey', successorId: 'r-found', type: 'FS', lagMinutes: 480 },
        { predecessorId: 'r-site', successorId: 'r-found', type: 'SS', lagMinutes: 0 },
      ],
    })
  })

  it('reads an empty or blank string as no dependencies', () => {
    expect(parsePredecessorInput(data, 'r-found', '')).toEqual({ ok: true, deps: [] })
    expect(parsePredecessorInput(data, 'r-found', '   ')).toEqual({ ok: true, deps: [] })
  })

  it('passes parse errors through', () => {
    const r = parsePredecessorInput(data, 'r-found', '2XX')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/unknown dependency type/)
  })

  it('rejects a missing row, the row itself and a row listed twice', () => {
    expect(parsePredecessorInput(data, 'r-found', '99')).toEqual({ ok: false, error: 'Row 99 does not exist' })
    expect(parsePredecessorInput(data, 'r-found', '4')).toEqual({ ok: false, error: 'A row cannot depend on itself' })
    expect(parsePredecessorInput(data, 'r-found', '2FS, 2SS')).toEqual({ ok: false, error: 'Row 2 is listed more than once' })
  })
})
