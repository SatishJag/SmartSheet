import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SheetData } from '../../store/persistence'
import { SheetStoreProvider } from '../../store/SheetStoreContext'
import { COL, makeRow, makeSheetData, makeTestStore } from '../../test/fixtures'
import { GridView } from './GridView'

async function renderGrid(data: SheetData = makeSheetData()) {
  const { store, persistence } = await makeTestStore(data)
  const state = store.getState()
  const spies = {
    indentRow: vi.spyOn(state, 'indentRow'),
    outdentRow: vi.spyOn(state, 'outdentRow'),
    moveRow: vi.spyOn(state, 'moveRow'),
  }
  const user = userEvent.setup()
  render(
    <SheetStoreProvider store={store}>
      <GridView viewportHeight={600} />
    </SheetStoreProvider>,
  )
  return { store, persistence, user, ...spies }
}

/** Three top-level rows: 1 r-a, 2 r-b, 3 r-c. */
const flatData = () =>
  makeSheetData({
    dependencies: [],
    rows: [
      makeRow('r-a', 'a0', { [COL.task]: 'Mobilise' }),
      makeRow('r-b', 'a1', { [COL.task]: 'Excavate' }),
      makeRow('r-c', 'a2', { [COL.task]: 'Pour' }),
    ],
  })

/** Body rows in display order. */
const bodyRows = () => screen.getAllByRole('row').slice(1)
/** The row number shown in the row header (its first text node; a scheduler warning may follow). */
const numberOf = (row: HTMLElement) => within(row).getByRole('rowheader').childNodes[0]?.textContent
/** Row numbers in display order. */
const displayedNumbers = () => bodyRows().map(numberOf)

/** The body row showing a 1-based sheet row number. */
function rowOf(rowNumber: number): HTMLElement {
  const row = bodyRows().find((r) => numberOf(r) === String(rowNumber))
  if (!row) throw new Error(`Row ${rowNumber} is not displayed`)
  return row
}

function header(title: string): HTMLElement {
  const h = screen.getAllByRole('columnheader').find((el) => el.textContent === title)
  if (!h) throw new Error(`No column header "${title}"`)
  return h
}

function cell(rowNumber: number, title: string): HTMLElement {
  const colIndex = header(title).getAttribute('aria-colindex')
  const c = within(rowOf(rowNumber))
    .getAllByRole('gridcell')
    .find((el) => el.getAttribute('aria-colindex') === colIndex)
  if (!c) throw new Error(`No cell for row ${rowNumber}, column "${title}"`)
  return c
}

const dataTransfer = () => ({ setData: vi.fn(), getData: vi.fn(() => ''), dropEffect: 'none', effectAllowed: 'all' })

function drag(fromRow: number, toRow: number) {
  const dt = dataTransfer()
  fireEvent.dragStart(within(rowOf(fromRow)).getByRole('rowheader'), { dataTransfer: dt })
  const target = rowOf(toRow)
  fireEvent.dragOver(target, { dataTransfer: dt })
  return { target, drop: () => fireEvent.drop(target, { dataTransfer: dt }) }
}

describe('indent and outdent', () => {
  it('Tab on the primary-column cell indents the active row', async () => {
    const { store, user } = await renderGrid(flatData())
    await user.click(cell(2, 'Task'))
    await user.keyboard('{Tab}')
    expect(store.getState().data!.rows.find((r) => r.id === 'r-b')!.parentId).toBe('r-a')
    expect(rowOf(2)).toHaveAttribute('aria-level', '2')
    expect(rowOf(1)).toHaveAttribute('aria-expanded', 'true')
    expect(cell(2, 'Task')).toHaveFocus()
  })

  it('Tab on the first row does nothing and shows no error', async () => {
    const { persistence, user } = await renderGrid(flatData())
    await user.click(cell(1, 'Task'))
    await user.keyboard('{Tab}')
    expect(persistence.saveRowTree).not.toHaveBeenCalled()
    expect(rowOf(1)).toHaveAttribute('aria-level', '1')
    expect(cell(1, 'Task')).toHaveFocus()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Shift+Tab outdents the active row', async () => {
    const { store, user } = await renderGrid()
    await user.click(cell(2, 'Task'))
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(store.getState().data!.rows.find((r) => r.id === 'r-survey')!.parentId).toBeNull()
    // Survey now follows its former parent's subtree: site, clear, survey, foundations.
    expect(rowOf(3)).toHaveAttribute('aria-level', '1')
    expect(cell(3, 'Task')).toHaveTextContent('Survey')
    expect(cell(3, 'Task')).toHaveFocus()
  })

  it('Tab in a non-primary column moves focus normally and does not indent', async () => {
    const { indentRow, user } = await renderGrid(flatData())
    await user.click(cell(2, 'Status'))
    await user.keyboard('{Tab}')
    expect(indentRow).not.toHaveBeenCalled()
    expect(cell(2, 'Status')).not.toHaveFocus()
  })

  it('toolbar Indent and Outdent act on the active row', async () => {
    const { store, user } = await renderGrid(flatData())
    const indent = screen.getByRole('button', { name: 'Indent' })
    const outdent = screen.getByRole('button', { name: 'Outdent' })
    expect(indent).toBeDisabled()
    expect(outdent).toBeDisabled()

    await user.click(cell(3, 'Status'))
    await user.click(indent)
    expect(store.getState().data!.rows.find((r) => r.id === 'r-c')!.parentId).toBe('r-b')
    await user.click(outdent)
    expect(store.getState().data!.rows.find((r) => r.id === 'r-c')!.parentId).toBeNull()
  })
})

describe('indent under a collapsed parent', () => {
  /** 1 r-a (parent of r-a1, collapsed in the tests), 2 r-a1, 3 r-b. */
  const nested = () =>
    makeSheetData({
      dependencies: [],
      rows: [
        makeRow('r-a', 'a0', { [COL.task]: 'Mobilise' }),
        makeRow('r-a1', 'a0', { [COL.task]: 'Site office' }, 'r-a'),
        makeRow('r-b', 'a1', { [COL.task]: 'Excavate' }),
      ],
    })

  it('Tab expands the new parent so the row stays visible and focused', async () => {
    const { user } = await renderGrid(nested())
    await user.click(screen.getByRole('button', { name: 'Collapse Mobilise' }))
    await user.click(cell(3, 'Task'))
    await user.keyboard('{Tab}')
    expect(rowOf(1)).toHaveAttribute('aria-expanded', 'true')
    expect(displayedNumbers()).toEqual(['1', '2', '3'])
    expect(cell(3, 'Task')).toHaveTextContent('Excavate')
    expect(cell(3, 'Task')).toHaveAttribute('aria-selected', 'true')
    expect(cell(3, 'Task')).toHaveFocus()
  })

  it('the toolbar Indent button expands the new parent too', async () => {
    const { user } = await renderGrid(nested())
    await user.click(screen.getByRole('button', { name: 'Collapse Mobilise' }))
    await user.click(cell(3, 'Status'))
    await user.click(screen.getByRole('button', { name: 'Indent' }))
    expect(rowOf(1)).toHaveAttribute('aria-expanded', 'true')
    expect(rowOf(3)).toHaveAttribute('aria-level', '2')
    expect(cell(3, 'Status')).toHaveAttribute('aria-selected', 'true')
  })
})

describe('collapse', () => {
  it('collapsing a parent hides its children and flips aria-expanded', async () => {
    const { user } = await renderGrid()
    const toggle = within(cell(1, 'Task')).getByRole('button', { name: 'Collapse Site preparation' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(rowOf(1)).toHaveAttribute('aria-expanded', 'true')
    expect(within(cell(2, 'Task')).queryByRole('button')).toBeNull() // leaves get no toggle

    await user.click(toggle)
    expect(displayedNumbers()).toEqual(['1', '4'])
    expect(screen.queryByText('Survey')).not.toBeInTheDocument()
    const expand = screen.getByRole('button', { name: 'Expand Site preparation' })
    expect(expand).toHaveAttribute('aria-expanded', 'false')
    expect(rowOf(1)).toHaveAttribute('aria-expanded', 'false')

    await user.click(expand)
    expect(displayedNumbers()).toEqual(['1', '2', '3', '4'])
  })

  it('indents child rows 16px per level', async () => {
    await renderGrid()
    const pad = (n: number) => (cell(n, 'Task').querySelector('.hierarchy-cell') as HTMLElement).style.paddingLeft
    expect(pad(1)).toBe('0px')
    expect(pad(2)).toBe('16px')
  })

  it('collapsing a parent while a child cell is active moves the active cell to the parent', async () => {
    const { user } = await renderGrid()
    await user.click(cell(3, 'Status'))
    await user.click(screen.getByRole('button', { name: 'Collapse Site preparation' }))
    expect(cell(1, 'Status')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('gridcell').filter((c) => c.getAttribute('aria-selected') === 'true')).toHaveLength(1)
    expect(cell(1, 'Status')).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(cell(4, 'Status')).toHaveAttribute('aria-selected', 'true')
  })
})

describe('sort', () => {
  it('header click cycles asc, desc, none; rows sort within their parent, keeping true row numbers', async () => {
    const { user } = await renderGrid()
    const start = header('Start')
    expect(start).toHaveAttribute('aria-sort', 'none')
    const sortButton = within(start).getByRole('button', { name: 'Start' })

    await user.click(sortButton)
    expect(header('Start')).toHaveAttribute('aria-sort', 'ascending')
    expect(displayedNumbers()).toEqual(['1', '2', '3', '4'])

    await user.click(sortButton)
    expect(header('Start')).toHaveAttribute('aria-sort', 'descending')
    // Scheduled starts: found 11-16 > site 11-09; inside the site: clear 11-11 > survey 11-09.
    expect(displayedNumbers()).toEqual(['4', '1', '3', '2'])
    expect(bodyRows().map((r) => r.getAttribute('aria-level'))).toEqual(['1', '1', '2', '2'])
    expect(cell(3, 'Task')).toHaveTextContent('Clear site')

    await user.click(sortButton)
    expect(header('Start')).toHaveAttribute('aria-sort', 'none')
    expect(displayedNumbers()).toEqual(['1', '2', '3', '4'])
  })

  it('only one column sorts at a time and blanks sort last', async () => {
    const { user } = await renderGrid()
    await user.click(within(header('Start')).getByRole('button', { name: 'Start' }))
    await user.click(within(header('Predecessors')).getByRole('button', { name: 'Predecessors' }))
    expect(header('Start')).toHaveAttribute('aria-sort', 'none')
    expect(header('Predecessors')).toHaveAttribute('aria-sort', 'ascending')
    // Top level: found has "3", the site is blank. Inside the site: clear has "2", survey is blank.
    expect(displayedNumbers()).toEqual(['4', '1', '3', '2'])
  })
})

describe('filter', () => {
  it('keeps ancestors of matching rows, hides other rows, and Clear restores', async () => {
    const { user } = await renderGrid()
    await user.selectOptions(screen.getByLabelText('Filter column'), 'Task')
    await user.selectOptions(screen.getByLabelText('Filter operator'), 'contains')
    await user.type(screen.getByLabelText('Filter value'), 'CLEAR')
    expect(displayedNumbers()).toEqual(['1', '3'])
    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '3')

    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(displayedNumbers()).toEqual(['1', '2', '3', '4'])
    expect(screen.getByLabelText('Filter value')).toHaveValue('')
  })

  it('hides the value input for isEmpty / isNotEmpty', async () => {
    const { user } = await renderGrid()
    await user.selectOptions(screen.getByLabelText('Filter column'), 'Predecessors')
    await user.selectOptions(screen.getByLabelText('Filter operator'), 'isEmpty')
    expect(screen.queryByLabelText('Filter value')).not.toBeInTheDocument()
    expect(displayedNumbers()).toEqual(['1', '2'])
  })

  it('overrides collapse', async () => {
    const { user } = await renderGrid()
    await user.click(screen.getByRole('button', { name: 'Collapse Site preparation' }))
    expect(displayedNumbers()).toEqual(['1', '4'])
    await user.type(screen.getByLabelText('Filter value'), 'survey')
    expect(displayedNumbers()).toEqual(['1', '2'])
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(displayedNumbers()).toEqual(['1', '4'])
  })
})

describe('drag to reorder', () => {
  it('dropping a row on another calls moveRow to place it after the target, as its sibling', async () => {
    const { moveRow, store } = await renderGrid()
    expect(within(rowOf(4)).getByRole('rowheader')).toHaveAttribute('draggable', 'true')
    const { target, drop } = drag(4, 2)
    expect(target).toHaveClass('is-drop-target')
    drop()
    expect(moveRow).toHaveBeenCalledWith('r-found', 'r-survey', 'r-site')
    expect(store.getState().data!.rows.find((r) => r.id === 'r-found')!.parentId).toBe('r-site')
    expect(displayedNumbers()).toEqual(['1', '2', '3', '4'])
    expect(cell(3, 'Task')).toHaveTextContent('Foundations')
    expect(bodyRows().some((r) => r.classList.contains('is-drop-target'))).toBe(false)
  })

  it('dropping a row on itself or on one of its descendants does nothing', async () => {
    const { moveRow } = await renderGrid()
    drag(1, 1).drop()
    drag(1, 3).drop()
    expect(moveRow).not.toHaveBeenCalled()
  })

  it('is disabled while a sort or a filter is active', async () => {
    const { moveRow, user } = await renderGrid()
    const sortButton = within(header('Task')).getByRole('button', { name: 'Task' })
    await user.click(sortButton)
    expect(within(rowOf(4)).getByRole('rowheader')).toHaveAttribute('draggable', 'false')
    drag(4, 2).drop()
    expect(moveRow).not.toHaveBeenCalled()

    await user.click(sortButton)
    await user.click(sortButton) // back to no sort
    await user.type(screen.getByLabelText('Filter value'), 'o')
    expect(within(rowOf(4)).getByRole('rowheader')).toHaveAttribute('draggable', 'false')
    drag(4, 1).drop()
    expect(moveRow).not.toHaveBeenCalled()
  })
})
