import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SheetData } from '../../store/persistence'
import { SheetStoreProvider } from '../../store/SheetStoreContext'
import { COL, makeRow, makeSheetData, makeTestStore } from '../../test/fixtures'
import { GridView } from './GridView'

async function renderGrid(data: SheetData = makeSheetData()) {
  const { store } = await makeTestStore(data)
  const setCell = vi.spyOn(store.getState(), 'setCell')
  const user = userEvent.setup()
  render(
    <SheetStoreProvider store={store}>
      <GridView viewportHeight={600} />
    </SheetStoreProvider>,
  )
  const cellValue = (rowId: string, colId: string) =>
    store.getState().data!.rows.find((r) => r.id === rowId)!.cells[colId]
  return { store, setCell, user, cellValue }
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

const selectedCells = () => screen.getAllByRole('gridcell').filter((c) => c.getAttribute('aria-selected') === 'true')

/** Fires a copy or cut event at the focused element and returns the text the grid wrote. */
function copyEvent(type: 'copy' | 'cut'): string | undefined {
  const written: Record<string, string> = {}
  const clipboardData = {
    types: [] as string[],
    setData: (format: string, value: string) => {
      written[format] = value
    },
    getData: (format: string) => written[format] ?? '',
  }
  fireEvent[type](document.activeElement!, { clipboardData })
  return written['text/plain']
}

describe('range selection', () => {
  it('Shift+Arrow extends a rectangle from the anchor; a plain arrow collapses it', async () => {
    const { user } = await renderGrid()
    await user.click(cell(2, 'Task'))
    await user.keyboard('{Shift>}{ArrowDown}{ArrowRight}{/Shift}')
    expect(selectedCells()).toEqual([cell(2, 'Task'), cell(2, 'Start'), cell(3, 'Task'), cell(3, 'Start')])
    expect(cell(3, 'Start')).toHaveFocus() // the moving corner is the active cell
    expect(cell(3, 'Start')).toHaveClass('is-active')
    expect(cell(2, 'Task')).toHaveClass('is-selected')
    expect(screen.getByRole('grid')).toHaveAttribute('aria-multiselectable', 'true')

    // Shrinking back past the anchor flips the rectangle.
    await user.keyboard('{Shift>}{ArrowUp}{ArrowUp}{/Shift}')
    expect(selectedCells()).toEqual([cell(1, 'Task'), cell(1, 'Start'), cell(2, 'Task'), cell(2, 'Start')])

    await user.keyboard('{ArrowDown}')
    expect(selectedCells()).toEqual([cell(2, 'Start')])
    expect(screen.getAllByRole('gridcell').filter((c) => c.classList.contains('is-selected'))).toHaveLength(0)
  })

  it('Shift+click extends the selection; a plain click collapses it', async () => {
    const { user } = await renderGrid()
    await user.click(cell(2, 'Duration'))
    await user.keyboard('{Shift>}')
    await user.click(cell(4, 'Status'))
    await user.keyboard('{/Shift}')
    expect(selectedCells()).toHaveLength(3 * 4) // rows 2-4, Duration..Status
    expect(cell(4, 'Status')).toHaveFocus()

    // A second Shift+click keeps the original anchor.
    await user.keyboard('{Shift>}')
    await user.click(cell(3, 'Predecessors'))
    await user.keyboard('{/Shift}')
    expect(selectedCells()).toEqual([cell(2, 'Duration'), cell(2, 'Predecessors'), cell(3, 'Duration'), cell(3, 'Predecessors')])

    await user.click(cell(1, 'Task'))
    expect(selectedCells()).toEqual([cell(1, 'Task')])
  })

  it('Escape collapses a range to the active cell; Tab still indents from the primary column', async () => {
    const { user, store } = await renderGrid()
    await user.click(cell(3, 'Task'))
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(selectedCells()).toHaveLength(2)
    await user.keyboard('{Escape}')
    expect(selectedCells()).toEqual([cell(3, 'Start')])

    await user.keyboard('{ArrowLeft}{Shift>}{ArrowDown}{/Shift}')
    expect(selectedCells()).toHaveLength(2)
    const indent = vi.spyOn(store.getState(), 'indentRow')
    await user.keyboard('{Tab}')
    expect(indent).toHaveBeenCalledWith('r-found')
  })

  it('Enter still edits the active cell of a range', async () => {
    const { user } = await renderGrid()
    await user.click(cell(2, 'Task'))
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}{Enter}')
    expect(within(cell(3, 'Task')).getByRole('textbox', { name: 'Task' })).toHaveValue('Clear site')
  })
})

describe('copy and cut', () => {
  it('copies the selection as TSV of the values the cells show', async () => {
    const { user } = await renderGrid()
    await user.click(cell(2, 'Task'))
    await user.keyboard('{Shift>}{ArrowDown}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}')
    expect(copyEvent('copy')).toBe(
      ['Survey\t2026-11-09\t2026-11-10\t2d\t\t100%', 'Clear site\t2026-11-11\t2026-11-13\t3d\t2FS\t50%'].join('\n'),
    )
  })

  it('copies a single active cell', async () => {
    const { user } = await renderGrid()
    await user.click(cell(3, 'Status'))
    expect(copyEvent('copy')).toBe('In progress')
  })

  it('copies the formula text of a formula cell, not its result', async () => {
    const data = makeSheetData()
    data.rows[3].cells[COL.task] = '=2*21'
    const { user } = await renderGrid(data)
    expect(cell(4, 'Task')).toHaveTextContent('42')
    await user.click(cell(4, 'Task'))
    expect(copyEvent('copy')).toBe('=2*21')
  })

  it('quotes values with tabs or line breaks', async () => {
    const data = makeSheetData()
    data.rows[3].cells[COL.task] = 'Pour\tcure\nstrip'
    const { user } = await renderGrid(data)
    await user.click(cell(4, 'Task'))
    expect(copyEvent('copy')).toBe('"Pour\tcure\nstrip"')
  })

  it('cut copies, then clears the editable cells and leaves read-only ones', async () => {
    const { user, cellValue } = await renderGrid()
    await user.click(cell(2, 'End'))
    await user.keyboard('{Shift>}{ArrowDown}{ArrowRight}{/Shift}')
    expect(copyEvent('cut')).toBe('2026-11-10\t2d\n2026-11-13\t3d')
    expect(cellValue('r-survey', COL.duration)).toBeNull()
    expect(cellValue('r-clear', COL.duration)).toBeNull()
    expect(cell(2, 'End')).toHaveTextContent('2026-11-09') // End is calculated, not cleared
  })

  it('leaves copy alone while a cell is being edited', async () => {
    const { user } = await renderGrid()
    await user.dblClick(cell(2, 'Task'))
    const editor = within(cell(2, 'Task')).getByRole('textbox')
    expect(editor).toHaveFocus()
    expect(copyEvent('copy')).toBeUndefined()
  })
})

describe('paste', () => {
  it('pastes a block from the top-left selected cell through setCell', async () => {
    const { user, setCell } = await renderGrid()
    await user.click(cell(2, 'Duration'))
    await user.paste('4d\t\t50\r\n1d\t\t25\r\n')
    expect(setCell).toHaveBeenCalledWith('r-survey', COL.duration, '4d')
    expect(setCell).toHaveBeenCalledWith('r-survey', COL.percent, '50')
    expect(setCell).toHaveBeenCalledWith('r-clear', COL.duration, '1d')
    expect(setCell).toHaveBeenCalledWith('r-clear', COL.predecessors, '')
    expect(cell(2, 'Duration')).toHaveTextContent('4d')
    expect(cell(3, 'Duration')).toHaveTextContent('1d')
    expect(cell(3, 'Predecessors')).toHaveTextContent('')
    expect(cell(2, '% Complete')).toHaveTextContent('50%')
    // The pasted block becomes the selection.
    expect(selectedCells()).toHaveLength(6)
    expect(cell(2, 'Duration')).toHaveClass('is-active')
  })

  it('writes a whole paste, and a clear, inside one store batch (one reschedule)', async () => {
    const { store, user, setCell } = await renderGrid()
    const original = store.getState().batch
    let callsInside = 0
    const batch = vi.spyOn(store.getState(), 'batch').mockImplementation((fn) => {
      const before = setCell.mock.calls.length
      try {
        return original(fn)
      } finally {
        callsInside += setCell.mock.calls.length - before
      }
    })
    await user.click(cell(2, 'Duration'))
    await user.paste('4d\t\t50\r\n1d\t\t25\r\n')
    expect(batch).toHaveBeenCalledTimes(1)
    expect(setCell.mock.calls.length).toBeGreaterThan(0)
    expect(callsInside).toBe(setCell.mock.calls.length) // every write happened inside the batch
    await user.keyboard('{Backspace}')
    expect(batch).toHaveBeenCalledTimes(2)
    expect(callsInside).toBe(setCell.mock.calls.length)
  })

  it('skips cells whose value would not change', async () => {
    const { user, setCell } = await renderGrid()
    await user.click(cell(2, 'Task'))
    await user.paste('Survey\tNew start')
    expect(setCell).not.toHaveBeenCalledWith('r-survey', COL.task, expect.anything())
  })

  it('fills a multi-cell selection with a single pasted value', async () => {
    const { user, cellValue, store } = await renderGrid()
    await user.click(cell(2, 'Status'))
    await user.keyboard('{Shift>}{ArrowDown}{ArrowDown}{/Shift}')
    await user.paste('Done\n')
    expect(['r-survey', 'r-clear', 'r-found'].map((id) => cellValue(id, COL.status))).toEqual(['Done', 'Done', 'Done'])
    expect(store.getState().notices).toEqual([])
  })

  it('pastes quoted fields with embedded tabs and line breaks', async () => {
    const { user, cellValue } = await renderGrid()
    await user.click(cell(2, 'Task'))
    await user.paste('"Line 1\nLine 2"\r\n"Say ""hi""\tthere"\r\n')
    expect(cellValue('r-survey', COL.task)).toBe('Line 1\nLine 2')
    expect(cellValue('r-clear', COL.task)).toBe('Say "hi"\tthere')
  })

  it('keeps old values for rejected and read-only cells and sums them up in one notice', async () => {
    const { user, cellValue, store } = await renderGrid()
    await user.click(cell(3, 'Start'))
    // Row 3's Start is set by its predecessor, End is calculated, "soon" is not a duration.
    await user.paste('2026-12-01\t2026-12-05\tsoon\t\t75')
    expect(cellValue('r-clear', COL.duration)).toBe('3d')
    expect(cellValue('r-clear', COL.percent)).toBe(75)
    expect(cell(3, 'Duration')).toHaveAttribute('aria-invalid', 'true')
    expect(cell(3, 'Duration')).toHaveTextContent(/^3d/)
    const notices = store.getState().notices
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/^3 cells were not pasted: row 3 Start \(.+\); row 3 End \(read-only\); row 3 Duration \(Enter a duration/)
  })

  it('does not paste into the rolled-up cells of a parent row', async () => {
    const { user, setCell, store } = await renderGrid()
    await user.click(cell(1, 'Task'))
    // Start and End re-pasted as they show are no error, though they cannot be written.
    await user.paste('Site works\t2026-11-09\t2026-11-13\t9d')
    expect(cell(1, 'Task')).toHaveTextContent('Site works')
    expect(setCell).not.toHaveBeenCalledWith('r-site', COL.start, expect.anything())
    expect(setCell).not.toHaveBeenCalledWith('r-site', COL.duration, expect.anything())
    expect(store.getState().notices).toEqual(['1 cell was not pasted: row 1 Duration (read-only)'])
  })

  it('drops rows past the end of the sheet instead of adding rows', async () => {
    const { user, store } = await renderGrid()
    await user.click(cell(4, 'Task'))
    await user.paste('A\nB\nC')
    expect(cell(4, 'Task')).toHaveTextContent('A')
    expect(store.getState().data!.rows).toHaveLength(4)
    expect(store.getState().notices).toEqual(['2 cells were not pasted: 2 past the end of the sheet'])
  })

  it('leaves paste to the editor while a cell is being edited', async () => {
    const { user, setCell } = await renderGrid()
    await user.dblClick(cell(2, 'Task'))
    const editor = within(cell(2, 'Task')).getByRole('textbox')
    await user.clear(editor)
    await user.paste('a\tb')
    expect(setCell).not.toHaveBeenCalled()
    expect(editor).toHaveValue('a\tb')
  })

  it('works on rows outside the rendered window (selection is by row id, not DOM)', async () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      makeRow(`r${i}`, `a${String(i).padStart(5, '0')}`, { [COL.task]: `Task ${i + 1}` }),
    )
    const { user, cellValue } = await renderGrid(makeSheetData({ rows, dependencies: [] }))
    await user.click(cell(1, 'Task'))
    const block = Array.from({ length: 80 }, (_, i) => `Pasted ${i + 1}`).join('\n')
    await user.paste(block)
    expect(screen.queryByText('Pasted 80')).not.toBeInTheDocument() // not rendered
    expect(cellValue('r79', COL.task)).toBe('Pasted 80')
    expect(cellValue('r80', COL.task)).toBe('Task 81')
    // The whole pasted block is selected and copies back, rendered or not.
    expect(copyEvent('copy')).toBe(block)
  })
})

describe('clearing a selection', () => {
  it('Backspace clears the editable cells of the selection', async () => {
    const { user, cellValue } = await renderGrid()
    await user.click(cell(2, 'Task'))
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}{Backspace}')
    expect(cellValue('r-survey', COL.task)).toBeNull()
    expect(cellValue('r-clear', COL.task)).toBeNull()
  })

  it('Backspace clears a single cell', async () => {
    const { user, cellValue } = await renderGrid()
    await user.click(cell(3, 'Status'))
    await user.keyboard('{Backspace}')
    expect(cellValue('r-clear', COL.status)).toBeNull()
    expect(screen.getAllByRole('row')).toHaveLength(5) // nothing deleted
  })

  it('Delete on a range clears cells instead of deleting rows; read-only cells are skipped quietly', async () => {
    const { user, cellValue, store } = await renderGrid()
    await user.click(cell(1, 'Duration'))
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}{Delete}')
    expect(store.getState().data!.rows).toHaveLength(4)
    expect(cellValue('r-survey', COL.duration)).toBeNull()
    expect(store.getState().notices).toEqual([])
  })
})
