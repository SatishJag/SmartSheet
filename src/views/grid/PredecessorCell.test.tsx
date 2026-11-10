import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SheetStoreProvider } from '../../store/SheetStoreContext'
import { makeSheetData, makeTestStore } from '../../test/fixtures'
import { GridView } from './GridView'

// Fixture: 1 Site preparation (parent), 2 Survey, 3 Clear site, 4 Foundations; 2 -> 3, 3 -> 4 (FS).

async function renderGrid(data = makeSheetData()) {
  const { store, persistence } = await makeTestStore(data)
  const user = userEvent.setup()
  render(
    <SheetStoreProvider store={store}>
      <GridView viewportHeight={600} />
    </SheetStoreProvider>,
  )
  return { store, persistence, user }
}

function cell(rowNumber: number, title: string): HTMLElement {
  const h = screen.getAllByRole('columnheader').find((el) => el.textContent === title)!
  const row = screen.getAllByRole('row').find((r) => r.getAttribute('aria-rowindex') === String(rowNumber + 1))!
  return within(row)
    .getAllByRole('gridcell')
    .find((el) => el.getAttribute('aria-colindex') === h.getAttribute('aria-colindex'))!
}

describe('predecessor cell', () => {
  it('shows the string derived from dependencies with a tooltip naming each predecessor', async () => {
    const data = makeSheetData()
    data.dependencies.push({ predecessorId: 'r-site', successorId: 'r-found', type: 'SS', lagMinutes: 480 })
    await renderGrid(data)
    expect(cell(3, 'Predecessors')).toHaveTextContent(/^2FS$/)
    expect(cell(4, 'Predecessors')).toHaveTextContent(/^1SS \+1d, 3FS$/)
    expect(within(cell(4, 'Predecessors')).getByText('1SS +1d, 3FS')).toHaveAttribute(
      'title',
      '1: Site preparation\n3: Clear site',
    )
    expect(cell(2, 'Predecessors')).toHaveTextContent(/^$/)
  })

  it('opens the editor with the derived string; committing it moves the successor\'s Start', async () => {
    const { user, persistence } = await renderGrid()
    expect(cell(3, 'Start')).toHaveTextContent('2026-11-11')
    await user.dblClick(cell(3, 'Predecessors'))
    const input = within(cell(3, 'Predecessors')).getByRole('textbox')
    expect(input).toHaveValue('2FS')
    await user.clear(input)
    await user.type(input, '2FS +1d{Enter}')
    expect(cell(3, 'Predecessors')).toHaveTextContent(/^2FS \+1d$/)
    expect(cell(3, 'Start')).toHaveTextContent('2026-11-12')
    expect(persistence.saveCell).not.toHaveBeenCalled()
  })

  it('an unchanged entry is not an edit', async () => {
    const { user, store } = await renderGrid()
    const setCell = vi.spyOn(store.getState(), 'setCell')
    const setPredecessors = vi.spyOn(store.getState(), 'setPredecessors')
    const before = store.getState().data
    await user.dblClick(cell(3, 'Predecessors'))
    expect(within(cell(3, 'Predecessors')).getByRole('textbox')).toHaveValue('2FS')
    await user.keyboard('{Enter}')
    expect(setCell).not.toHaveBeenCalled()
    expect(setPredecessors).not.toHaveBeenCalled()
    expect(store.getState().data).toBe(before)
  })

  it('an invalid entry shows the error marker and keeps the old string', async () => {
    const { user } = await renderGrid()
    await user.dblClick(cell(3, 'Predecessors'))
    const input = within(cell(3, 'Predecessors')).getByRole('textbox')
    await user.clear(input)
    await user.type(input, '99{Enter}')
    const c = cell(3, 'Predecessors')
    expect(c).toHaveAttribute('aria-invalid', 'true')
    expect(c).toHaveAttribute('title', 'Row 99 does not exist')
    expect(c).toHaveTextContent(/^2FS/)
    expect(cell(3, 'Start')).toHaveTextContent('2026-11-11')
  })
})
