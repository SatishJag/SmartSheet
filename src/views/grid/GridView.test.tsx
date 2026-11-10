import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SheetData } from '../../store/persistence'
import { SheetStoreProvider } from '../../store/SheetStoreContext'
import { COL, fixtureColumns, fsDep, makeRow, makeSheetData, makeTestStore } from '../../test/fixtures'
import { GridView } from './GridView'

async function renderGrid(data: SheetData = makeSheetData()) {
  const { store, persistence } = await makeTestStore(data)
  const setCell = vi.spyOn(store.getState(), 'setCell')
  const user = userEvent.setup()
  render(
    <SheetStoreProvider store={store}>
      <GridView viewportHeight={600} />
    </SheetStoreProvider>,
  )
  return { store, persistence, setCell, user }
}

function header(title: string): HTMLElement {
  const h = screen.getAllByRole('columnheader').find((el) => el.textContent === title)
  if (!h) throw new Error(`No column header "${title}"`)
  return h
}

/** The grid cell at a 1-based sheet row number and a column title. */
function cell(rowNumber: number, title: string): HTMLElement {
  const colIndex = header(title).getAttribute('aria-colindex')
  const row = screen.getAllByRole('row').find((r) => r.getAttribute('aria-rowindex') === String(rowNumber + 1))
  if (!row) throw new Error(`Row ${rowNumber} is not rendered`)
  const c = within(row)
    .getAllByRole('gridcell')
    .find((el) => el.getAttribute('aria-colindex') === colIndex)
  if (!c) throw new Error(`No cell for row ${rowNumber}, column "${title}"`)
  return c
}

const editorIn = (el: HTMLElement) => el.querySelector('input:not([type="checkbox"]), select, textarea')

describe('GridView rendering', () => {
  it('renders 5,000 rows with fewer than 100 row elements in the DOM', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) =>
      makeRow(`r${i}`, `a${String(i).padStart(5, '0')}`, { [COL.task]: `Task ${i + 1}` }),
    )
    await renderGrid(makeSheetData({ rows, dependencies: [] }))

    const grid = screen.getByRole('grid')
    expect(grid).toHaveAttribute('aria-rowcount', '5001')
    const domRows = screen.getAllByRole('row')
    expect(domRows.length).toBeLessThan(100)
    expect(domRows.length).toBeGreaterThan(10)
    expect(screen.getByText('Task 1')).toBeInTheDocument()
    expect(screen.queryByText('Task 5000')).not.toBeInTheDocument()
  })

  it('renders headers, row numbers in tree order and stored values', async () => {
    await renderGrid()
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      '',
      ...fixtureColumns.map((c) => c.title),
    ])
    expect(cell(1, 'Task')).toHaveTextContent('Site preparation')
    expect(cell(2, 'Task')).toHaveTextContent('Survey')
    expect(cell(3, 'Task')).toHaveTextContent('Clear site')
    expect(cell(4, 'Task')).toHaveTextContent('Foundations')
    expect(cell(3, 'Predecessors')).toHaveTextContent('2')
    expect(cell(3, 'Status')).toHaveTextContent('In progress')
    expect(cell(3, 'Duration')).toHaveTextContent('3d')
  })

  it('shows scheduled dates and parent roll-ups, and updates them after an edit', async () => {
    const { store, user } = await renderGrid()
    expect(cell(2, 'Start')).toHaveTextContent('2026-11-09')
    expect(cell(2, 'End')).toHaveTextContent('2026-11-10')
    expect(cell(3, 'Start')).toHaveTextContent('2026-11-11')
    expect(cell(3, 'End')).toHaveTextContent('2026-11-13')
    expect(cell(4, 'Start')).toHaveTextContent('2026-11-16')
    expect(cell(1, 'Start')).toHaveTextContent('2026-11-09')
    expect(cell(1, 'End')).toHaveTextContent('2026-11-13')
    const parent = store.getState().scheduled.byRow['r-site']
    expect(cell(1, 'Duration')).toHaveTextContent(`${parent.durationDays}d`)
    expect(cell(1, '% Complete')).toHaveTextContent(`${Math.round(parent.percentComplete)}%`)

    await user.dblClick(cell(2, 'Duration'))
    const input = screen.getByRole('textbox', { name: 'Duration' })
    await user.clear(input)
    await user.type(input, '4d{Enter}')

    expect(cell(2, 'End')).toHaveTextContent('2026-11-12')
    expect(cell(3, 'Start')).toHaveTextContent('2026-11-13')
    expect(cell(4, 'Start')).toHaveTextContent('2026-11-18')
  })

  it('shows scheduler errors as a warning marker on the row', async () => {
    await renderGrid(makeSheetData({ dependencies: [fsDep('r-survey', 'r-clear'), fsDep('ghost', 'r-found')] }))
    const marker = screen.getByRole('img', { name: /Unknown predecessor ghost/ })
    const row4 = screen.getAllByRole('row').find((r) => r.getAttribute('aria-rowindex') === '5')!
    expect(row4).toContainElement(marker)
    expect(marker).toHaveAttribute('title', expect.stringMatching(/Unknown predecessor ghost/))
  })
})

describe('GridView editing', () => {
  it('double-click opens a text editor and Enter commits through setCell', async () => {
    const { setCell, user } = await renderGrid()
    await user.dblClick(cell(2, 'Task'))
    const input = screen.getByRole('textbox', { name: 'Task' })
    expect(input).toHaveValue('Survey')
    await user.clear(input)
    await user.type(input, 'Survey and stake out{Enter}')

    expect(setCell).toHaveBeenCalledTimes(1)
    expect(setCell).toHaveBeenCalledWith('r-survey', COL.task, 'Survey and stake out')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(cell(2, 'Task')).toHaveTextContent('Survey and stake out')
  })

  it('Enter on the selected cell opens the editor', async () => {
    const { setCell, user } = await renderGrid()
    await user.click(cell(4, 'Task'))
    await user.keyboard('{Enter}')
    const input = screen.getByRole('textbox', { name: 'Task' })
    await user.clear(input)
    await user.type(input, 'Footings{Enter}')
    expect(setCell).toHaveBeenCalledWith('r-found', COL.task, 'Footings')
    expect(cell(4, 'Task')).toHaveTextContent('Footings')
  })

  it('Escape cancels without calling setCell', async () => {
    const { setCell, user } = await renderGrid()
    await user.dblClick(cell(2, 'Task'))
    await user.type(screen.getByRole('textbox', { name: 'Task' }), ' changed')
    await user.keyboard('{Escape}')

    expect(setCell).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(cell(2, 'Task')).toHaveTextContent(/^Survey$/)
  })

  it('blur commits the edit', async () => {
    const { setCell, user } = await renderGrid()
    await user.dblClick(cell(2, 'Task'))
    const input = screen.getByRole('textbox', { name: 'Task' })
    await user.clear(input)
    await user.type(input, 'Topographic survey')
    await user.click(cell(4, 'Task'))

    expect(setCell).toHaveBeenCalledTimes(1)
    expect(setCell).toHaveBeenCalledWith('r-survey', COL.task, 'Topographic survey')
    expect(cell(2, 'Task')).toHaveTextContent('Topographic survey')
  })

  it('an invalid date shows an error marker, keeps the old value, and clears after a valid edit', async () => {
    const { setCell, user } = await renderGrid()
    await user.dblClick(cell(2, 'Start'))
    const input = screen.getByLabelText('Start')
    expect(input).toHaveAttribute('type', 'date')
    expect(input).toHaveValue('2026-11-09')
    fireEvent.change(input, { target: { value: '12026-01-01' } })
    await user.keyboard('{Enter}')

    expect(setCell).toHaveBeenCalledWith('r-survey', COL.start, '12026-01-01')
    expect(setCell).toHaveLastReturnedWith({ ok: false, error: 'Enter a valid date as YYYY-MM-DD' })
    const bad = cell(2, 'Start')
    expect(editorIn(bad)).toBeNull()
    expect(bad).toHaveTextContent('2026-11-09')
    expect(bad).toHaveAttribute('aria-invalid', 'true')
    expect(bad).toHaveAttribute('title', 'Enter a valid date as YYYY-MM-DD')
    expect(bad).toHaveAccessibleDescription('Enter a valid date as YYYY-MM-DD')

    await user.dblClick(cell(2, 'Start'))
    const again = screen.getByLabelText('Start')
    fireEvent.change(again, { target: { value: '2026-11-10' } })
    await user.keyboard('{Enter}')

    const good = cell(2, 'Start')
    expect(good).toHaveTextContent('2026-11-10')
    expect(good).not.toHaveAttribute('aria-invalid', 'true')
    expect(good).not.toHaveAttribute('title')
  })

  it("does not open an editor on a parent row's Start, Duration or % Complete", async () => {
    const { setCell, user } = await renderGrid()
    for (const title of ['Start', 'Duration', '% Complete']) {
      await user.dblClick(cell(1, title))
      expect(editorIn(cell(1, title))).toBeNull()
      await user.click(cell(1, title))
      await user.keyboard('{Enter}')
      expect(editorIn(cell(1, title))).toBeNull()
      expect(cell(1, title)).toHaveAttribute('aria-readonly', 'true')
    }
    expect(setCell).not.toHaveBeenCalled()
    // The parent's own Task cell is still editable.
    await user.dblClick(cell(1, 'Task'))
    expect(screen.getByRole('textbox', { name: 'Task' })).toBeInTheDocument()
  })

  it('does not open an editor on an End cell', async () => {
    const { user } = await renderGrid()
    await user.dblClick(cell(2, 'End'))
    expect(editorIn(cell(2, 'End'))).toBeNull()
    await user.keyboard('{Enter}')
    expect(editorIn(cell(2, 'End'))).toBeNull()
    expect(cell(2, 'End')).toHaveAttribute('aria-readonly', 'true')
  })

  it('a checkbox cell toggles immediately and commits "true"/"false"', async () => {
    const columns = [...fixtureColumns, { id: 'c-insp', title: 'Inspected', type: 'CHECKBOX' as const }]
    const { setCell, user } = await renderGrid(makeSheetData({ columns }))
    const box = within(cell(2, 'Inspected')).getByRole('checkbox')
    expect(box).not.toBeChecked()
    await user.click(box)
    expect(setCell).toHaveBeenLastCalledWith('r-survey', 'c-insp', 'true')
    expect(within(cell(2, 'Inspected')).getByRole('checkbox')).toBeChecked()
    await user.click(within(cell(2, 'Inspected')).getByRole('checkbox'))
    expect(setCell).toHaveBeenLastCalledWith('r-survey', 'c-insp', 'false')
    expect(within(cell(2, 'Inspected')).getByRole('checkbox')).not.toBeChecked()
  })

  it('a picklist cell edits with a select that has a blank option plus the options', async () => {
    const { setCell, user } = await renderGrid()
    await user.dblClick(cell(4, 'Status'))
    const select = screen.getByRole('combobox', { name: 'Status' })
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '',
      'Not started',
      'In progress',
      'Done',
    ])
    expect(select).toHaveValue('Not started')
    await user.selectOptions(select, 'In progress')
    expect(setCell).toHaveBeenCalledWith('r-found', COL.status, 'In progress')
    expect(cell(4, 'Status')).toHaveTextContent('In progress')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('arrow keys move the active cell', async () => {
    const { user } = await renderGrid()
    await user.click(cell(2, 'Task'))
    expect(cell(2, 'Task')).toHaveAttribute('aria-selected', 'true')
    expect(cell(2, 'Task')).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    expect(cell(3, 'Task')).toHaveAttribute('aria-selected', 'true')
    expect(cell(2, 'Task')).not.toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowRight}')
    expect(cell(3, 'Start')).toHaveAttribute('aria-selected', 'true')
    expect(cell(3, 'Start')).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(cell(2, 'Start')).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(cell(2, 'Task')).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(cell(1, 'Task')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('gridcell').filter((c) => c.getAttribute('aria-selected') === 'true')).toHaveLength(1)
  })
})

describe('GridView keyboard entry', () => {
  it('Tab into the grid activates the first cell; arrows and Enter then work without a mouse', async () => {
    const { user } = await renderGrid()
    await user.tab()
    expect(cell(1, 'Task')).toHaveFocus()
    expect(cell(1, 'Task')).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{ArrowDown}')
    expect(cell(2, 'Task')).toHaveAttribute('aria-selected', 'true')
    expect(cell(2, 'Task')).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(screen.getByRole('textbox', { name: 'Task' })).toHaveValue('Survey')
  })

  it('keeps one tabbable cell when row 1 is scrolled out of the rendered window', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) =>
      makeRow(`r${i}`, `a${String(i).padStart(5, '0')}`, { [COL.task]: `Task ${i + 1}` }),
    )
    const { user } = await renderGrid(makeSheetData({ rows, dependencies: [] }))
    const scroller = screen.getByRole('grid').parentElement!
    act(() => {
      scroller.scrollTop = 32 * 2000
      fireEvent.scroll(scroller)
    })
    expect(screen.queryByText('Task 1')).not.toBeInTheDocument()

    const tabbable = screen.getAllByRole('gridcell').filter((c) => c.tabIndex === 0)
    expect(tabbable).toHaveLength(1)
    await user.tab()
    expect(tabbable[0]).toHaveFocus()
    expect(tabbable[0]).toHaveAttribute('aria-selected', 'true')
  })
})

describe('GridView rows', () => {
  it('a sheet with zero rows shows the headers, an empty state and an Add row button', async () => {
    const { store, user } = await renderGrid(makeSheetData({ rows: [], dependencies: [] }))
    expect(header('Task')).toBeInTheDocument()
    expect(header('Status')).toBeInTheDocument()
    expect(screen.getByText('No rows yet')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add row' }))
    expect(store.getState().data!.rows).toHaveLength(1)
    expect(screen.queryByText('No rows yet')).not.toBeInTheDocument()
    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '2')
    expect(cell(1, 'Task')).toBeInTheDocument()
  })

  it('Add row adds a row after the last row', async () => {
    const { store, user } = await renderGrid()
    const addRow = vi.spyOn(store.getState(), 'addRow')
    await user.click(screen.getByRole('button', { name: 'Add row' }))
    expect(addRow).toHaveBeenCalledWith('r-found')
    expect(store.getState().data!.rows).toHaveLength(5)
    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '6')
    expect(cell(5, 'Task')).toHaveTextContent('')
  })
})

describe('GridView column resize', () => {
  it('dragging a header edge changes the column width, with a 60px minimum', async () => {
    await renderGrid()
    const task = header('Task')
    const before = parseFloat(task.style.width)
    expect(before).toBeGreaterThan(0)

    const handle = within(task).getByRole('separator', { name: 'Resize Task' })
    fireEvent.mouseDown(handle, { clientX: 300 })
    fireEvent.mouseMove(document, { clientX: 380 })
    fireEvent.mouseUp(document, { clientX: 380 })
    expect(header('Task').style.width).toBe(`${before + 80}px`)
    expect(cell(2, 'Task').style.width).toBe(`${before + 80}px`)

    fireEvent.mouseDown(handle, { clientX: 300 })
    fireEvent.mouseMove(document, { clientX: -2000 })
    fireEvent.mouseUp(document, { clientX: -2000 })
    expect(header('Task').style.width).toBe('60px')
  })
})
