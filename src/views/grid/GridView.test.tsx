import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SheetData } from '../../store/persistence'
import { SheetStoreProvider } from '../../store/SheetStoreContext'
import { COL, fixtureColumns, fsDep, makeRow, makeSheetData, makeTestStore } from '../../test/fixtures'
import { GridView } from './GridView'
import { buildDisplayRows } from './viewModel'

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

  it('committing an unchanged value (Enter or blur) does not call setCell', async () => {
    const { setCell, persistence, user } = await renderGrid()
    await user.dblClick(cell(2, 'Task'))
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(cell(2, 'Task')).toHaveFocus()

    await user.dblClick(cell(3, 'Task'))
    expect(screen.getByRole('textbox', { name: 'Task' })).toHaveValue('Clear site')
    await user.click(cell(4, 'Task'))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    expect(setCell).not.toHaveBeenCalled()
    expect(persistence.saveCell).not.toHaveBeenCalled()
  })

  it('double-clicking a checkbox toggles it only for its two clicks', async () => {
    const columns = [...fixtureColumns, { id: 'c-insp', title: 'Inspected', type: 'CHECKBOX' as const }]
    const { setCell, user } = await renderGrid(makeSheetData({ columns }))
    await user.dblClick(within(cell(2, 'Inspected')).getByRole('checkbox'))
    expect(setCell).toHaveBeenCalledTimes(2)
    expect(within(cell(2, 'Inspected')).getByRole('checkbox')).not.toBeChecked()
    expect(editorIn(cell(2, 'Inspected'))).toBeNull()
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
    expect(within(screen.getByRole('grid')).queryByRole('combobox')).not.toBeInTheDocument()
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

describe('GridView dependency-driven Start', () => {
  it('a Start cell on a row with predecessors has no editor and explains why', async () => {
    const { user, setCell } = await renderGrid()
    const start = cell(3, 'Start') // Clear site depends on Survey
    expect(start).toHaveAttribute('aria-readonly', 'true')
    expect(start).toHaveAttribute('title', 'Start date is set by predecessors — edit the Predecessors column to move this task')
    await user.dblClick(start)
    expect(editorIn(start)).toBeNull()
    await user.keyboard('{Enter}')
    expect(editorIn(start)).toBeNull()
    expect(setCell).not.toHaveBeenCalled()
  })

  it('a Start cell on a row without predecessors stays editable', async () => {
    const { user } = await renderGrid()
    const start = cell(2, 'Start') // Survey
    expect(start).not.toHaveAttribute('aria-readonly')
    await user.dblClick(start)
    expect(editorIn(start)).not.toBeNull()
  })
})

describe('GridView formulas', () => {
  const formulaColumns = [
    { id: 'task', title: 'Task', type: 'TEXT_NUMBER' as const },
    { id: 'qty', title: 'Qty', type: 'TEXT_NUMBER' as const },
    { id: 'cost', title: 'Cost', type: 'TEXT_NUMBER' as const },
    { id: 'calc', title: 'Calc', type: 'TEXT_NUMBER' as const },
    { id: 'start', title: 'Start', type: 'DATE' as const, role: 'start' as const },
  ]
  const formulaSheet = (calc: unknown[]) =>
    makeSheetData({
      columns: formulaColumns,
      rows: calc.map((c, i) => makeRow(`f${i}`, `a${i}`, { task: `T${i + 1}`, qty: i + 1, cost: 10 * (i + 1), calc: c })),
      dependencies: [],
    })

  it('shows evaluated results: arithmetic, SUM over a column, IF on the row', async () => {
    await renderGrid(formulaSheet(['=1+2', '=SUM([Cost])', '=IF([Qty]>2,"big","small")', '=[Qty]>3']))
    expect(cell(1, 'Calc')).toHaveTextContent(/^3$/)
    expect(cell(2, 'Calc')).toHaveTextContent(/^100$/)
    expect(cell(3, 'Calc')).toHaveTextContent(/^big$/)
    expect(cell(4, 'Calc')).toHaveTextContent(/^TRUE$/)
  })

  it('the editor opens with the formula text, and a new formula shows its result', async () => {
    const { user, setCell } = await renderGrid(formulaSheet(['=1+2']))
    await user.dblClick(cell(1, 'Calc'))
    const editor = screen.getByRole('textbox', { name: 'Calc' })
    expect(editor).toHaveValue('=1+2')
    await user.clear(editor)
    await user.type(editor, '=[[Qty]*5{Enter}') // "[[" types a literal "["
    expect(setCell).toHaveBeenCalledWith('f0', 'calc', '=[Qty]*5')
    expect(cell(1, 'Calc')).toHaveTextContent(/^5$/)
  })

  it.each([
    ['=1/0', 'Division by zero'],
    ['=FOO(1)', "Unknown function 'FOO'"],
    ['=[Nope]+1', "Unknown column 'Nope'"],
  ])('%s shows #ERROR with the error marker and message', async (formula, message) => {
    await renderGrid(formulaSheet([formula]))
    const c = cell(1, 'Calc')
    expect(c).toHaveTextContent(/^#ERROR/)
    expect(c).toHaveAttribute('aria-invalid', 'true')
    expect(c).toHaveAttribute('title', message)
    expect(c).toHaveAccessibleDescription(message)
  })

  it('a self reference shows #CIRCULAR', async () => {
    await renderGrid(formulaSheet(['=[Calc]+1']))
    expect(cell(1, 'Calc')).toHaveTextContent(/^#CIRCULAR/)
    expect(cell(1, 'Calc')).toHaveAttribute('aria-invalid', 'true')
  })

  it('a formula in a schedule-role column is still rejected', async () => {
    const { store } = await renderGrid(formulaSheet(['=1']))
    expect(store.getState().setCell('f0', 'start', '=TODAY()')).toEqual({
      ok: false,
      error: 'Formulas are not allowed in start columns',
    })
  })

  it('sorts and filters by the evaluated value', async () => {
    // Raw text would sort =1+3, =2*100, =50-20; the values are 30, 4, 200.
    const { store, user } = await renderGrid(formulaSheet(['=50-20', '=1+3', '=2*100']))
    await user.click(within(header('Calc')).getByRole('button'))
    const order = () =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map((r) => within(r).getAllByRole('gridcell')[0].textContent)
    expect(order()).toEqual(['T2', 'T1', 'T3']) // 4, 30, 200 numerically

    const { data, scheduled } = store.getState()
    const filtered = buildDisplayRows(data, scheduled, {
      collapsed: new Set(),
      sort: null,
      filter: { colId: 'calc', op: 'greaterThan', value: '10' },
    })
    expect(filtered.map((r) => r.id)).toEqual(['f0', 'f2'])
  })
})

describe('GridView row deletion', () => {
  const ids = (store: Awaited<ReturnType<typeof renderGrid>>['store']) => store.getState().data!.rows.map((r) => r.id)

  it('Delete row is disabled with no active row; on a leaf row it deletes at once and moves the active cell', async () => {
    const { store, user } = await renderGrid()
    const button = screen.getByRole('button', { name: 'Delete row' })
    expect(button).toBeDisabled()

    await user.click(cell(4, 'Task')) // Foundations, the last row
    await user.click(button)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(ids(store)).toEqual(['r-site', 'r-survey', 'r-clear'])
    // No row after it: the active cell moves to the previous row.
    expect(cell(3, 'Task')).toHaveAttribute('aria-selected', 'true')
    expect(store.getState().notices).toEqual(['Removed 1 dependency that referenced deleted rows'])
  })

  it('the Delete row button deletes the active leaf row and the next row becomes active', async () => {
    const { store, user } = await renderGrid()
    await user.click(cell(2, 'Duration')) // Survey
    await user.click(screen.getByRole('button', { name: 'Delete row' }))
    expect(ids(store)).toEqual(['r-site', 'r-clear', 'r-found'])
    expect(cell(2, 'Task')).toHaveTextContent('Clear site')
    expect(cell(2, 'Duration')).toHaveAttribute('aria-selected', 'true')
    expect(cell(2, 'Duration')).toHaveFocus()
  })

  it('the Delete key does nothing while an editor is open', async () => {
    const { store, user } = await renderGrid()
    await user.dblClick(cell(2, 'Task'))
    await user.keyboard('{Delete}')
    expect(ids(store)).toHaveLength(4)
    expect(screen.getByRole('textbox', { name: 'Task' })).toBeInTheDocument()
  })

  it('a row with sub-rows asks first in an accessible dialog; Escape cancels and returns focus', async () => {
    const { store, user } = await renderGrid()
    await user.click(cell(1, 'Duration')) // Site preparation, 2 sub-rows
    const deleteButton = screen.getByRole('button', { name: 'Delete row' })
    await user.click(deleteButton)
    const dialog = screen.getByRole('alertdialog', { name: 'Delete row' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleDescription('Delete this row and its 2 sub-rows?')
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(ids(store)).toHaveLength(4)
    expect(deleteButton).toHaveFocus()
  })

  it('confirming deletes the row and its sub-rows', async () => {
    const { store, user } = await renderGrid()
    await user.click(cell(1, 'Task'))
    await user.click(screen.getByRole('button', { name: 'Delete row' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(ids(store)).toEqual(['r-found'])
    expect(cell(1, 'Task')).toHaveAttribute('aria-selected', 'true')
  })

  it('deleting the only row clears the active cell', async () => {
    const { store, user } = await renderGrid(makeSheetData({ rows: [makeRow('only', 'a0', { [COL.task]: 'Only' })], dependencies: [] }))
    await user.click(cell(1, 'Task'))
    await user.click(screen.getByRole('button', { name: 'Delete row' }))
    expect(ids(store)).toEqual([])
    expect(screen.getByRole('button', { name: 'Delete row' })).toBeDisabled()
  })
})

const selectedCells = () => screen.getAllByRole('gridcell').filter((c) => c.getAttribute('aria-selected') === 'true')
const statusText = () => screen.getByRole('status').textContent
const cellValue = (store: Awaited<ReturnType<typeof renderGrid>>['store'], rowId: string, colId: string) =>
  store.getState().data!.rows.find((r) => r.id === rowId)!.cells[colId]

describe('GridView range selection', () => {
  it('Shift+arrows grow a rectangle from the anchor; a plain arrow collapses it', async () => {
    const { user } = await renderGrid()
    await user.click(cell(2, 'Task'))
    await user.keyboard('{Shift>}{ArrowDown}{ArrowRight}{/Shift}')
    expect(selectedCells()).toEqual([cell(2, 'Task'), cell(2, 'Start'), cell(3, 'Task'), cell(3, 'Start')])
    expect(cell(3, 'Start')).toHaveFocus()
    expect(screen.getByRole('grid')).toHaveAttribute('aria-multiselectable', 'true')

    await user.keyboard('{ArrowDown}')
    expect(selectedCells()).toEqual([cell(4, 'Start')])
  })

  it('Shift+click selects the rectangle from the active cell; Home and End jump along the row', async () => {
    const { user } = await renderGrid()
    await user.click(cell(2, 'Duration'))
    await user.keyboard('{Shift>}')
    await user.click(cell(4, 'Predecessors'))
    await user.keyboard('{/Shift}')
    expect(selectedCells()).toHaveLength(6) // rows 2-4 x Duration..Predecessors

    await user.keyboard('{End}')
    expect(selectedCells()).toEqual([cell(4, 'Status')])
    await user.keyboard('{Home}')
    expect(selectedCells()).toEqual([cell(4, 'Task')])
  })
})

/** Fires a copy event at the focused cell and returns the text the grid put on the clipboard. */
function copiedText(): string {
  let text = ''
  const clipboardData = { setData: (_type: string, data: string) => (text = data) }
  fireEvent.copy(document.activeElement!, { clipboardData })
  return text
}

describe('GridView copy and paste', () => {
  it('copies the selected range as tab-separated displayed values', async () => {
    const { user } = await renderGrid()
    await user.click(cell(2, 'Task'))
    await user.keyboard('{Shift>}{ArrowDown}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}')
    expect(copiedText()).toBe(
      'Survey\t2026-11-09\t2026-11-10\t2d\nClear site\t2026-11-11\t2026-11-13\t3d',
    )
  })

  it('copies a range larger than the rendered window', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => makeRow(`r${i}`, `a${String(i).padStart(5, '0')}`, { [COL.task]: `Task ${i + 1}` }))
    const { user } = await renderGrid(makeSheetData({ rows, dependencies: [] }))
    await user.click(cell(1, 'Task'))
    await user.keyboard('{Control>}{Shift>}{End}{/Shift}{/Control}')
    const lines = copiedText().split('\n')
    expect(lines).toHaveLength(5000)
    expect(lines[4999].split('\t')[0]).toBe('Task 5000')
  })

  it('pastes through setCell: an invalid cell keeps its value and is reported once, the rest pastes', async () => {
    const { store, setCell, user } = await renderGrid()
    await user.click(cell(2, 'Status'))
    await user.paste('Not started\nBogus\nDone')
    expect(setCell).toHaveBeenCalledTimes(3)
    expect(cellValue(store, 'r-survey', COL.status)).toBe('Not started')
    expect(cellValue(store, 'r-clear', COL.status)).toBe('In progress')
    expect(cellValue(store, 'r-found', COL.status)).toBe('Done')
    expect(cell(3, 'Status')).toHaveAttribute('aria-invalid', 'true')
    expect(statusText()).toMatch(/^Pasted 2 cells, 1 skipped: row 3 Status: Choose one of: /)
    expect(selectedCells()).toHaveLength(3) // the pasted block, active cell at its top-left
    expect(cell(2, 'Status')).toHaveAttribute('aria-selected', 'true')
  })

  it('skips read-only cells and says why, but still pastes the rest', async () => {
    const { store, user } = await renderGrid()
    await user.click(cell(2, 'Start'))
    await user.paste('2026-11-10\n2026-11-20') // row 3 Start is set by its predecessor
    expect(cellValue(store, 'r-survey', COL.start)).toBe('2026-11-10')
    expect(cellValue(store, 'r-clear', COL.start)).toBeUndefined()
    expect(statusText()).toMatch(/^Pasted 1 cell, 1 skipped: row 3 Start: Start date is set by predecessors/)
  })

  it('clips a block that runs past the last row or column', async () => {
    const { store, user } = await renderGrid()
    await user.click(cell(4, 'Status'))
    await user.paste('Done\tx\nignored')
    expect(cellValue(store, 'r-found', COL.status)).toBe('Done')
    expect(statusText()).toBe('Pasted 1 cell, 2 past the edge of the grid ignored')
  })

  it('reads Excel-style quoted fields and CRLF line ends', async () => {
    const { store, user } = await renderGrid()
    await user.click(cell(2, 'Task'))
    await user.paste('"Say ""hi""\nthere"\r\nNext\r\n')
    expect(cellValue(store, 'r-survey', COL.task)).toBe('Say "hi"\nthere')
    expect(cellValue(store, 'r-clear', COL.task)).toBe('Next')
  })

  it('follows the displayed row order when sorted', async () => {
    const { store, user } = await renderGrid()
    await user.click(within(header('Task')).getByRole('button')) // ascending: Foundations, Site preparation, then Clear site, Survey
    await user.click(cell(3, 'Task'))
    expect(cell(3, 'Task')).toHaveTextContent('Clear site')
    await user.paste('A\nB')
    expect(cellValue(store, 'r-clear', COL.task)).toBe('A')
    expect(cellValue(store, 'r-survey', COL.task)).toBe('B')
  })

  it('Delete and Backspace clear the selected cells through setCell, skipping read-only ones', async () => {
    const { store, user } = await renderGrid()
    await user.click(cell(2, 'Status'))
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}{Delete}')
    expect(cellValue(store, 'r-survey', COL.status)).toBeNull()
    expect(cellValue(store, 'r-clear', COL.status)).toBeNull()
    expect(statusText()).toBe('Cleared 2 cells')

    await user.click(cell(3, 'Start'))
    await user.keyboard('{Backspace}')
    expect(statusText()).toMatch(/^Cleared 0 cells, 1 skipped: row 3 Start: Start date is set by predecessors/)
    expect(screen.getAllByRole('row')).toHaveLength(5) // no row was deleted
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
