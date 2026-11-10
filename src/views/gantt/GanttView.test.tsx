import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { DepType } from '../../engine/types'
import type { SheetData } from '../../store/persistence'
import { SheetStoreProvider } from '../../store/SheetStoreContext'
import { COL, fixtureColumns, fsDep, makeRow, makeSheetData, makeTestStore } from '../../test/fixtures'
import { GanttView } from './GanttView'

const DW = 28

async function renderGantt(data: SheetData = makeSheetData(), today = '2026-01-01') {
  const { store } = await makeTestStore(data)
  const setCell = vi.spyOn(store.getState(), 'setCell')
  render(
    <SheetStoreProvider store={store}>
      <GanttView viewportHeight={600} dayWidth={DW} today={today} />
    </SheetStoreProvider>,
  )
  return { store, setCell }
}

/** A sheet of top-level rows built from [id, name, start, duration, percent?]. */
function sheet(rows: [string, string, string | null, string, number?][], deps: SheetData['dependencies'] = []) {
  return makeSheetData({
    rows: rows.map(([id, name, start, dur, pct], i) =>
      makeRow(id, `a${i}`, {
        [COL.task]: name,
        ...(start ? { [COL.start]: start } : {}),
        [COL.duration]: dur,
        ...(pct !== undefined ? { [COL.percent]: pct } : {}),
      }),
    ),
    dependencies: deps,
  })
}

const bar = (name: string) => screen.getByRole('img', { name: new RegExp(`^${name}:`) })
const queryBar = (name: string) => screen.queryByRole('img', { name: new RegExp(`^${name}:`) })
const body = (name: string) => bar(name).querySelector('.gantt-bar-body') as SVGElement
const num = (el: Element, attr: string) => Number(el.getAttribute(attr))
const left = (name: string) => num(body(name), 'x')
const right = (name: string) => num(body(name), 'x') + num(body(name), 'width')
const arrows = () => document.querySelectorAll('[data-testid="dep-arrow"]')

/** First x (after M) and last x (final H) of an arrow path. */
function pathEnds(path: Element): { x1: number; x2: number } {
  const d = path.getAttribute('d')!
  const x1 = Number(/^M\s*(-?[\d.]+)/.exec(d)![1])
  const hs = [...d.matchAll(/H\s*(-?[\d.]+)/g)]
  return { x1, x2: Number(hs[hs.length - 1][1]) }
}

function drag(target: Element, dx: number, opts: { cancel?: boolean } = {}) {
  fireEvent.pointerDown(target, { clientX: 100, clientY: 10, button: 0, pointerId: 1 })
  fireEvent.pointerMove(window, { clientX: 100 + dx, clientY: 10, pointerId: 1 })
  if (opts.cancel) fireEvent.keyDown(window, { key: 'Escape' })
  fireEvent.pointerUp(window, { clientX: 100 + dx, clientY: 10, pointerId: 1 })
}

describe('GanttView bars', () => {
  it('renders a 3-day task exactly 3 day-columns wide with progress and an accessible label', async () => {
    await renderGantt(sheet([['a', 'Pour foundation', '2026-11-09', '3d', 40]]))
    const g = screen.getByRole('img', { name: 'Pour foundation: 2026-11-09 to 2026-11-11, 3 days, 40% complete' })
    expect(g).toHaveAttribute('data-kind', 'task')
    expect(g.querySelector('title')).toHaveTextContent('Pour foundation')
    const rect = body('Pour foundation')
    expect(num(rect, 'width')).toBe(3 * DW)
    expect(num(rect, 'x')).toBe(3 * DW) // range starts 3 days before the earliest start
    expect(num(rect, 'height')).toBe(16)
    expect(num(g.querySelector('.gantt-bar-progress')!, 'width')).toBeCloseTo(0.4 * 3 * DW)
  })

  it('draws a task spanning a weekend across all its calendar days', async () => {
    await renderGantt(sheet([['a', 'Frame', '2026-11-12', '3d']])) // Thu, Fri, (Sat, Sun), Mon
    expect(num(body('Frame'), 'width')).toBe(5 * DW)
  })

  it('draws a milestone as a diamond and a parent row as a summary bar', async () => {
    await renderGantt(
      makeSheetData({
        rows: [
          makeRow('p', 'a0', { [COL.task]: 'Phase 1' }),
          makeRow('t', 'a0', { [COL.task]: 'Dig', [COL.start]: '2026-11-09', [COL.duration]: '2d' }, 'p'),
          makeRow('m', 'a1', { [COL.task]: 'Handover', [COL.start]: '2026-11-11', [COL.duration]: '0d' }),
        ],
        dependencies: [],
      }),
    )
    const m = bar('Handover')
    expect(m).toHaveAttribute('data-kind', 'milestone')
    expect(m.querySelector('polygon')).not.toBeNull()
    expect(m.querySelector('.gantt-bar-handle')).toBeNull() // milestones cannot be resized
    expect(bar('Phase 1')).toHaveAttribute('data-kind', 'summary')
    expect(num(body('Phase 1'), 'width')).toBe(2 * DW)
    expect(bar('Dig')).toHaveAttribute('data-kind', 'task')
  })

  it('renders far fewer bars than rows on a 5,000-row sheet', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) =>
      makeRow(`r${i}`, `a${String(i).padStart(5, '0')}`, {
        [COL.task]: `Task ${i + 1}`,
        [COL.start]: '2026-11-09',
        [COL.duration]: '1d',
      }),
    )
    await renderGantt(makeSheetData({ rows, dependencies: [] }))
    const kinds = document.querySelectorAll('[data-kind]')
    expect(kinds.length).toBeGreaterThan(10)
    expect(kinds.length).toBeLessThan(100)
  })

  it('shows a warning on rows the scheduler could not schedule, without a bar', async () => {
    await renderGantt(sheet([['a', 'Ready', '2026-11-09', '1d'], ['b', 'Undated', null, '1d']]))
    expect(queryBar('Ready')).not.toBeNull()
    expect(queryBar('Undated')).toBeNull()
    expect(screen.getByLabelText('Scheduling error: No start date')).toBeInTheDocument()
  })
})

describe('GanttView timeline', () => {
  it('shades non-working days', async () => {
    await renderGantt(sheet([['a', 'Dig', '2026-11-09', '3d']]))
    const shaded = (iso: string) => document.querySelector(`[data-testid="nonworking-day"][data-date="${iso}"]`)
    expect(shaded('2026-11-14')).not.toBeNull()
    expect(shaded('2026-11-15')).not.toBeNull()
    expect(shaded('2026-11-13')).toBeNull()
  })

  it('draws the today line only when today is in range', async () => {
    await renderGantt(sheet([['a', 'Dig', '2026-11-09', '3d']]), '2026-11-10')
    const line = screen.getByTestId('today-line')
    expect(num(line, 'x1')).toBe(4 * DW + DW / 2)
  })

  it('omits the today line when today is out of range', async () => {
    await renderGantt(sheet([['a', 'Dig', '2026-11-09', '3d']]), '2030-01-01')
    expect(screen.queryByTestId('today-line')).toBeNull()
  })

  it('shows the empty states', async () => {
    await renderGantt(makeSheetData({ rows: [], dependencies: [] }))
    expect(screen.getByText('No scheduled tasks to display')).toBeInTheDocument()
  })

  it('asks for a Start column when the sheet has none', async () => {
    await renderGantt(makeSheetData({ columns: fixtureColumns.filter((c) => c.role !== 'start') }))
    expect(screen.getByText('Add a Start column to see the Gantt chart')).toBeInTheDocument()
  })

  it('hides child bars when a parent is collapsed', async () => {
    await renderGantt()
    const toggle = screen.getByRole('button', { name: 'Collapse Site preparation' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(queryBar('Survey')).not.toBeNull()
    await userEvent.setup().click(toggle)
    expect(queryBar('Survey')).toBeNull()
    expect(queryBar('Clear site')).toBeNull()
    expect(queryBar('Foundations')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Expand Site preparation' })).toHaveAttribute('aria-expanded', 'false')
    expect(arrows()).toHaveLength(0) // both dependencies touch a hidden row
  })
})

describe('GanttView dependency arrows', () => {
  it('draws one FS arrow per dependency from predecessor end to successor start', async () => {
    await renderGantt()
    expect(arrows()).toHaveLength(2)
    const a = screen.getByRole('img', { name: 'Row 2 to Row 3 (FS)' })
    expect(a).toHaveAttribute('data-testid', 'dep-arrow')
    expect(a).toHaveAttribute('data-dep-type', 'FS')
    expect(a.getAttribute('marker-end')).toMatch(/url\(#/)
    expect(pathEnds(a)).toEqual({ x1: right('Survey'), x2: left('Clear site') })
    expect(a.closest('[pointer-events="none"]')).not.toBeNull()
  })

  it.each<[DepType, 'left' | 'right', 'left' | 'right']>([
    ['SS', 'left', 'left'],
    ['FF', 'right', 'right'],
    ['SF', 'left', 'right'],
  ])('anchors %s arrows on the correct edges', async (type, from, to) => {
    await renderGantt(
      sheet([['a', 'Alpha', '2026-11-09', '3d'], ['b', 'Beta', null, '2d']], [
        { predecessorId: 'a', successorId: 'b', type, lagMinutes: 0 },
      ]),
    )
    const a = arrows()
    expect(a).toHaveLength(1)
    expect(a[0]).toHaveAttribute('data-dep-type', type)
    const edge = (side: 'left' | 'right', name: string) => (side === 'left' ? left(name) : right(name))
    expect(pathEnds(a[0])).toEqual({ x1: edge(from, 'Alpha'), x2: edge(to, 'Beta') })
  })

  it('draws no arrow when an endpoint has no schedule', async () => {
    // b and c form a cycle, so neither is scheduled; a is.
    await renderGantt(
      sheet([['a', 'Alpha', '2026-11-09', '1d'], ['b', 'Beta', null, '1d'], ['c', 'Gamma', null, '1d']], [
        fsDep('a', 'b'),
        fsDep('b', 'c'),
        fsDep('c', 'b'),
      ]),
    )
    expect(queryBar('Alpha')).not.toBeNull()
    expect(arrows()).toHaveLength(0)
  })
})

describe('GanttView drag', () => {
  // "Move me" is the only (so also the earliest) task: moving it must not move the timeline origin.
  const movable = () => sheet([['m', 'Move me', '2026-11-09', '2d']])
  /** Left x of a day's column, read from the header's day label. */
  const dayX = (iso: string) => num(document.querySelector(`.gantt-day[data-date="${iso}"]`)!, 'x') - DW / 2

  it('moves a bar one day right: previews, writes the start once, and the bar follows the store', async () => {
    const { setCell } = await renderGantt(movable())
    const x0 = left('Move me')
    fireEvent.pointerDown(body('Move me'), { clientX: 100, button: 0, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 100 + DW, pointerId: 1 })
    expect(left('Move me')).toBe(x0 + DW) // live preview
    expect(setCell).not.toHaveBeenCalled()
    fireEvent.pointerUp(window, { clientX: 100 + DW, pointerId: 1 })
    expect(setCell).toHaveBeenCalledTimes(1)
    expect(setCell).toHaveBeenCalledWith('m', COL.start, '2026-11-10')
    expect(left('Move me')).toBe(x0 + DW)
    expect(left('Move me')).toBe(dayX('2026-11-10')) // sits at the dropped date, no snap back
    expect(bar('Move me')).toHaveAccessibleName(/2026-11-10 to 2026-11-11/)
  })

  it('keeps the earliest bar at its dropped date after moving it right several days', async () => {
    const { setCell } = await renderGantt(movable())
    expect(left('Move me')).toBe(dayX('2026-11-09'))
    drag(body('Move me'), 3 * DW)
    expect(setCell).toHaveBeenCalledWith('m', COL.start, '2026-11-12')
    expect(left('Move me')).toBe(dayX('2026-11-12'))
    expect(left('Move me')).toBe(6 * DW) // origin unchanged: 2026-11-06
  })

  it('extends the timeline while a bar is dragged past either end, so it is not clipped', async () => {
    const { setCell } = await renderGantt(movable())
    const target = body('Move me')
    fireEvent.pointerDown(target, { clientX: 500, button: 0, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 500 - 6 * DW, pointerId: 1 }) // to 2026-11-03, before day 0
    expect(left('Move me')).toBeGreaterThanOrEqual(0)
    expect(left('Move me')).toBe(dayX('2026-11-03'))
    fireEvent.pointerMove(window, { clientX: 500 + 40 * DW, pointerId: 1 }) // far past the end
    const svgWidth = num(document.querySelector('.gantt-timeline')!, 'width')
    expect(right('Move me')).toBeLessThanOrEqual(svgWidth)
    expect(left('Move me')).toBe(dayX('2026-12-19'))
    fireEvent.pointerUp(window, { clientX: 500 + 40 * DW, pointerId: 1 })
    expect(setCell).toHaveBeenCalledWith('m', COL.start, '2026-12-19')
    expect(left('Move me')).toBe(dayX('2026-12-21')) // Saturday start is scheduled on Monday
  })

  it('makes no call for a drag under half a day', async () => {
    const { setCell } = await renderGantt(movable())
    const x0 = left('Move me')
    drag(body('Move me'), DW / 2 - 1)
    expect(setCell).not.toHaveBeenCalled()
    expect(left('Move me')).toBe(x0)
  })

  it('cancels with Escape', async () => {
    const { setCell } = await renderGantt(movable())
    const x0 = left('Move me')
    drag(body('Move me'), 2 * DW, { cancel: true })
    expect(setCell).not.toHaveBeenCalled()
    expect(left('Move me')).toBe(x0)
  })

  it('blocks moving a row whose start comes from predecessors', async () => {
    const { setCell } = await renderGantt()
    drag(body('Clear site'), DW)
    expect(setCell).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Start date is set by predecessors — edit the Predecessors column to move this task',
    )
  })

  it('blocks moving a summary bar', async () => {
    const { setCell } = await renderGantt()
    drag(body('Site preparation'), DW)
    expect(setCell).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent(/summary row/i)
  })

  it('resizes a row with a predecessor but still blocks moving it', async () => {
    const { setCell } = await renderGantt()
    // Clear site: Wed 11-11 .. Fri 11-13; + 1 day -> Sat, still 3 working days; + 3 -> Mon 11-16 = 4
    drag(bar('Clear site').querySelector('.gantt-bar-handle')!, 3 * DW)
    expect(setCell).toHaveBeenCalledTimes(1)
    expect(setCell).toHaveBeenCalledWith('r-clear', COL.duration, '4d')
    expect(screen.getByRole('status')).toHaveTextContent('')
    drag(body('Clear site'), DW)
    expect(setCell).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Start date is set by predecessors — edit the Predecessors column to move this task',
    )
  })

  it('resizes from the right edge, writing the duration in working days', async () => {
    const { setCell } = await renderGantt(sheet([['a', 'Frame', '2026-11-12', '1d']])) // Thu
    // Thu + 4 calendar days = Mon: Thu, Fri, Mon = 3 working days
    drag(bar('Frame').querySelector('.gantt-bar-handle')!, 4 * DW)
    expect(setCell).toHaveBeenCalledTimes(1)
    expect(setCell).toHaveBeenCalledWith('a', COL.duration, '3d')
    expect(num(body('Frame'), 'width')).toBe(5 * DW)
  })

  it('moves a milestone', async () => {
    const { setCell } = await renderGantt(sheet([['m', 'Handover', '2026-11-11', '0d']]))
    drag(bar('Handover').querySelector('.gantt-bar-body')!, DW)
    expect(setCell).toHaveBeenCalledWith('m', COL.start, '2026-11-12')
  })

  it('shows a store error in the status region', async () => {
    const { setCell } = await renderGantt(movable())
    setCell.mockReturnValue({ ok: false, error: 'Save rejected' })
    act(() => drag(body('Move me'), DW))
    expect(within(screen.getByRole('status')).getByText('Save rejected')).toBeInTheDocument()
  })
})
