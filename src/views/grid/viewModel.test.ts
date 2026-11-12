import { describe, expect, it } from 'vitest'
import type { ScheduleResult } from '../../engine/schedule'
import type { Column } from '../../model/validate'
import { COL, fixtureColumns, makeRow, makeSheetData } from '../../test/fixtures'
import { buildDisplayRows, type DisplayRow, type FilterSpec, type ViewState } from './viewModel'

const QTY = 'c-qty'
const DONE = 'c-done'
const columns: Column[] = [
  ...fixtureColumns,
  { id: QTY, title: 'Qty', type: 'TEXT_NUMBER' },
  { id: DONE, title: 'Done?', type: 'CHECKBOX' },
]

/**
 * Tree order (row numbers): 1 p1, 2 c1, 3 c2, 4 c3, 5 p2, 6 c4, 7 t3.
 * p1 has c1..c3, p2 has c4, t3 is a top-level leaf.
 */
const data = makeSheetData({
  columns,
  dependencies: [],
  rows: [
    makeRow('p1', 'a0', { [COL.task]: 'Phase one' }),
    makeRow('c1', 'a0', { [COL.task]: 'Pour slab', [COL.start]: '2026-03-05', [QTY]: 10, [DONE]: true }, 'p1'),
    makeRow('c2', 'a1', { [COL.task]: 'excavate', [COL.start]: '2026-03-01', [QTY]: '9' }, 'p1'),
    makeRow('c3', 'a2', { [COL.task]: 'Backfill', [QTY]: 100 }, 'p1'),
    makeRow('p2', 'a1', { [COL.task]: 'Phase two' }),
    makeRow('c4', 'a0', { [COL.task]: 'Frame walls', [COL.start]: '2026-02-01', [QTY]: 5 }, 'p2'),
    makeRow('t3', 'a2', { [COL.task]: 'Handover', [COL.start]: '2026-01-01' }),
  ],
})

const NONE: ScheduleResult = { byRow: {}, errors: [], critical: [] }
const view = (v: Partial<ViewState> = {}): ViewState => ({ collapsed: new Set(), sort: null, filter: null, ...v })
const ids = (rows: DisplayRow[]) => rows.map((r) => r.id)
const filtered = (filter: FilterSpec, scheduled = NONE) => ids(buildDisplayRows(data, scheduled, view({ filter })))

describe('buildDisplayRows: hierarchy', () => {
  it('lists every row in tree order with depth, true row numbers and parent flags', () => {
    const rows = buildDisplayRows(data, NONE, view())
    expect(rows).toEqual([
      { id: 'p1', depth: 0, rowNumber: 1, hasChildren: true, expanded: true },
      { id: 'c1', depth: 1, rowNumber: 2, hasChildren: false, expanded: false },
      { id: 'c2', depth: 1, rowNumber: 3, hasChildren: false, expanded: false },
      { id: 'c3', depth: 1, rowNumber: 4, hasChildren: false, expanded: false },
      { id: 'p2', depth: 0, rowNumber: 5, hasChildren: true, expanded: true },
      { id: 'c4', depth: 1, rowNumber: 6, hasChildren: false, expanded: false },
      { id: 't3', depth: 0, rowNumber: 7, hasChildren: false, expanded: false },
    ])
  })

  it('hides the descendants of a collapsed row', () => {
    const rows = buildDisplayRows(data, NONE, view({ collapsed: new Set(['p1']) }))
    expect(ids(rows)).toEqual(['p1', 'p2', 'c4', 't3'])
    expect(rows[0]).toMatchObject({ hasChildren: true, expanded: false })
  })

  it('returns nothing without data', () => {
    expect(buildDisplayRows(null, NONE, view())).toEqual([])
  })
})

describe('buildDisplayRows: sort', () => {
  it('sorts each sibling group by a date column, children staying under their parent, blanks last', () => {
    const asc = buildDisplayRows(data, NONE, view({ sort: { colId: COL.start, dir: 'asc' } }))
    expect(ids(asc)).toEqual(['t3', 'p1', 'c2', 'c1', 'c3', 'p2', 'c4'])
    // Row numbers stay the true tree-order numbers.
    expect(asc.map((r) => r.rowNumber)).toEqual([7, 1, 3, 2, 4, 5, 6])
    expect(asc.map((r) => r.depth)).toEqual([0, 0, 1, 1, 1, 0, 1])

    const desc = buildDisplayRows(data, NONE, view({ sort: { colId: COL.start, dir: 'desc' } }))
    expect(ids(desc)).toEqual(['t3', 'p1', 'c1', 'c2', 'c3', 'p2', 'c4'])
  })

  it('compares the scheduled start when the scheduler produced one', () => {
    const scheduled: ScheduleResult = {
      byRow: { c3: { start: '2026-02-15', end: '2026-02-16', durationDays: 2, percentComplete: 0 } },
      errors: [],
      critical: [],
    }
    const rows = buildDisplayRows(data, scheduled, view({ sort: { colId: COL.start, dir: 'asc' } }))
    expect(ids(rows)).toEqual(['t3', 'p1', 'c3', 'c2', 'c1', 'p2', 'c4'])
  })

  it('compares numbers numerically, numeric strings included', () => {
    const rows = buildDisplayRows(data, NONE, view({ sort: { colId: QTY, dir: 'asc' } }))
    expect(ids(rows).slice(1, 4)).toEqual(['c2', 'c1', 'c3'])
    const desc = buildDisplayRows(data, NONE, view({ sort: { colId: QTY, dir: 'desc' } }))
    expect(ids(desc).slice(1, 4)).toEqual(['c3', 'c1', 'c2'])
  })

  it('compares text with localeCompare', () => {
    const rows = buildDisplayRows(data, NONE, view({ sort: { colId: COL.task, dir: 'asc' } }))
    expect(ids(rows)).toEqual(['t3', 'p1', 'c3', 'c2', 'c1', 'p2', 'c4'])
  })

  it('orders checkboxes false before true, keeping stored order on ties', () => {
    const asc = buildDisplayRows(data, NONE, view({ sort: { colId: DONE, dir: 'asc' } }))
    expect(ids(asc).slice(1, 4)).toEqual(['c2', 'c3', 'c1'])
    const desc = buildDisplayRows(data, NONE, view({ sort: { colId: DONE, dir: 'desc' } }))
    expect(ids(desc).slice(1, 4)).toEqual(['c1', 'c2', 'c3'])
  })

  it('ignores a sort on an unknown column', () => {
    const rows = buildDisplayRows(data, NONE, view({ sort: { colId: 'nope', dir: 'desc' } }))
    expect(ids(rows)).toEqual(['p1', 'c1', 'c2', 'c3', 'p2', 'c4', 't3'])
  })
})

describe('buildDisplayRows: filter', () => {
  it('keeps ancestors of matching rows and hides non-matching leaves (contains is case-insensitive)', () => {
    const rows = buildDisplayRows(data, NONE, view({ filter: { colId: COL.task, op: 'contains', value: 'POUR' } }))
    expect(ids(rows)).toEqual(['p1', 'c1'])
    expect(rows.map((r) => r.rowNumber)).toEqual([1, 2])
  })

  it('overrides collapse while active', () => {
    const rows = buildDisplayRows(
      data,
      NONE,
      view({ collapsed: new Set(['p1']), filter: { colId: COL.task, op: 'contains', value: 'pour' } }),
    )
    expect(ids(rows)).toEqual(['p1', 'c1'])
    expect(rows[0].expanded).toBe(true)
  })

  it('equals and notEquals', () => {
    expect(filtered({ colId: COL.task, op: 'equals', value: 'handover' })).toEqual(['t3'])
    expect(filtered({ colId: COL.task, op: 'notEquals', value: 'Handover' })).toEqual(['p1', 'c1', 'c2', 'c3', 'p2', 'c4'])
    expect(filtered({ colId: QTY, op: 'equals', value: '9.0' })).toEqual(['p1', 'c2'])
  })

  it('greaterThan and lessThan on numbers', () => {
    expect(filtered({ colId: QTY, op: 'greaterThan', value: '9' })).toEqual(['p1', 'c1', 'c3'])
    expect(filtered({ colId: QTY, op: 'lessThan', value: '10' })).toEqual(['p1', 'c2', 'p2', 'c4'])
  })

  it('greaterThan and lessThan on dates', () => {
    expect(filtered({ colId: COL.start, op: 'greaterThan', value: '2026-02-15' })).toEqual(['p1', 'c1', 'c2'])
    expect(filtered({ colId: COL.start, op: 'lessThan', value: '2026-02-15' })).toEqual(['p2', 'c4', 't3'])
  })

  it('isEmpty and isNotEmpty', () => {
    expect(filtered({ colId: COL.start, op: 'isEmpty', value: '' })).toEqual(['p1', 'c3', 'p2'])
    expect(filtered({ colId: COL.start, op: 'isNotEmpty', value: '' })).toEqual(['p1', 'c1', 'c2', 'p2', 'c4', 't3'])
    expect(filtered({ colId: DONE, op: 'isNotEmpty', value: '' })).toEqual(['p1', 'c1'])
  })

  it('matches the displayed (scheduled) value', () => {
    const scheduled: ScheduleResult = {
      byRow: { c3: { start: '2026-02-15', end: '2026-02-16', durationDays: 2, percentComplete: 0 } },
      errors: [],
      critical: [],
    }
    expect(filtered({ colId: COL.start, op: 'contains', value: '2026-02-15' }, scheduled)).toEqual(['p1', 'c3'])
  })

  it('behaves as no filter for an unknown column or a missing value', () => {
    const all = ['p1', 'c1', 'c2', 'c3', 'p2', 'c4', 't3']
    expect(filtered({ colId: 'nope', op: 'contains', value: 'x' })).toEqual(all)
    expect(filtered({ colId: COL.task, op: 'contains', value: '  ' })).toEqual(all)
  })

  it('combines with sort', () => {
    const rows = buildDisplayRows(
      data,
      NONE,
      view({ sort: { colId: COL.start, dir: 'desc' }, filter: { colId: COL.start, op: 'isNotEmpty', value: '' } }),
    )
    expect(ids(rows)).toEqual(['t3', 'p1', 'c1', 'c2', 'p2', 'c4'])
  })
})
