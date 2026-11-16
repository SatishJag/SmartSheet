import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Column } from '../../model/validate'
import type { SheetData } from '../../store/persistence'
import { SheetStoreProvider } from '../../store/SheetStoreContext'
import { makeRow, makeSheetData, makeTestStore } from '../../test/fixtures'
import { GridView } from './GridView'

const columns: Column[] = [
  { id: 'task', title: 'Task', type: 'TEXT_NUMBER' },
  { id: 'qty', title: 'Qty', type: 'TEXT_NUMBER' },
  { id: 'rate', title: 'Rate', type: 'TEXT_NUMBER' },
  { id: 'total', title: 'Total', type: 'TEXT_NUMBER' },
  { id: 'ok', title: 'OK', type: 'CHECKBOX' },
]

const sheet = (extra: Partial<SheetData> = {}) =>
  makeSheetData({
    columns,
    rows: [
      makeRow('r1', 'a0', { task: 'Slab', qty: 2, rate: 10 }),
      makeRow('r2', 'a1', { task: 'Beam', qty: 3, rate: 5, total: '=[Qty]+1000' }),
      makeRow('r3', 'a2', { task: 'Pier', qty: 4, rate: 2 }),
    ],
    dependencies: [],
    ...extra,
  })

async function renderGrid(data: SheetData = sheet()) {
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
  const header = screen.getAllByRole('columnheader').find((el) => el.textContent === title)!
  const colIndex = header.getAttribute('aria-colindex')
  const row = screen.getAllByRole('row').find((r) => r.getAttribute('aria-rowindex') === String(rowNumber + 1))!
  return within(row)
    .getAllByRole('gridcell')
    .find((el) => el.getAttribute('aria-colindex') === colIndex)!
}

const bar = () => screen.getByRole('textbox', { name: 'Formula bar' })
const menuButton = (title: string) => screen.getByRole('button', { name: `Column menu for ${title}` })

async function setColumnFormula(user: ReturnType<typeof userEvent.setup>, title: string, formula: string) {
  await user.click(menuButton(title))
  await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /column formula/ }))
  const dialog = screen.getByRole('dialog', { name: `Column formula: ${title}` })
  const area = within(dialog).getByRole('combobox', { name: 'Formula' })
  await user.clear(area)
  await user.type(area, formula.replace(/\[/g, '[[')) // "[[" types a literal "["
  return dialog
}

describe('formula bar', () => {
  it('is disabled until a cell is active, then shows that cell\'s text', async () => {
    const { user } = await renderGrid()
    expect(bar()).toBeDisabled()
    await user.click(cell(1, 'Task'))
    expect(bar()).toBeEnabled()
    expect(bar()).toHaveValue('Slab')
    expect(screen.getByText('Task · row 1')).toBeInTheDocument()
  })

  it('shows =... for a formula cell, not its result', async () => {
    const { user } = await renderGrid()
    await user.click(cell(2, 'Total'))
    expect(cell(2, 'Total')).toHaveTextContent('1003')
    expect(bar()).toHaveValue('=[Qty]+1000')
  })

  it('Enter commits an edit through setCell and returns to the grid; the result shows', async () => {
    const { user, store } = await renderGrid()
    await user.click(cell(1, 'Total'))
    await user.type(bar(), '=[[Qty]*[[Rate]{Enter}') // "[[" types a literal "["
    expect(store.getState().data!.rows[0].cells.total).toBe('=[Qty]*[Rate]')
    expect(cell(1, 'Total')).toHaveTextContent('20')
    expect(cell(1, 'Total')).toHaveFocus()
  })

  it('Escape puts the original text back and commits nothing', async () => {
    const { user, store } = await renderGrid()
    await user.click(cell(2, 'Total'))
    await user.clear(bar())
    await user.type(bar(), '=1+1{Escape}')
    expect(bar()).toHaveValue('=[Qty]+1000')
    expect(store.getState().data!.rows[1].cells.total).toBe('=[Qty]+1000')
    expect(cell(2, 'Total')).toHaveFocus()
  })

  it('Enter without a change does not save anything', async () => {
    const { user, persistence } = await renderGrid()
    await user.click(cell(2, 'Total'))
    await user.click(bar())
    await user.keyboard('{Enter}')
    await new Promise((r) => setTimeout(r, 0))
    expect(persistence.saveCell).not.toHaveBeenCalled()
  })

  it('a read-only cell cannot be edited in the bar', async () => {
    const { user } = await renderGrid(makeSheetData())
    await user.click(cell(2, 'End'))
    expect(bar()).toBeDisabled()
  })

  it('shows the cell\'s error next to the bar', async () => {
    const data = sheet()
    data.rows[0].cells.total = '=[Qty]/0'
    const { user } = await renderGrid(data)
    await user.click(cell(1, 'Total'))
    expect(within(screen.getByRole('group', { name: 'Formula bar' })).getByText(/^#DIVIDE BY ZERO: /)).toBeInTheDocument()
  })
})

describe('error cells', () => {
  it('show the error name and explain it in a tooltip', async () => {
    const data = sheet()
    data.rows[0].cells.total = '=[Qty]/0'
    data.rows[2].cells.total = '=FOO(1)'
    await renderGrid(data)
    expect(cell(1, 'Total')).toHaveTextContent('#DIVIDE BY ZERO')
    expect(cell(1, 'Total')).toHaveAttribute('title', expect.stringMatching(/^#DIVIDE BY ZERO: .*zero/))
    expect(cell(3, 'Total')).toHaveTextContent('#UNPARSEABLE')
    expect(cell(3, 'Total').getAttribute('title')).toContain("Unknown function 'FOO'")
  })
})

describe('column formula', () => {
  it('"Set column formula" is in the column menu; the primary column\'s item is disabled with a reason', async () => {
    const { user } = await renderGrid()
    await user.click(menuButton('Total'))
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Set column formula' })).not.toHaveAttribute('aria-disabled')
    await user.keyboard('{Escape}')
    await user.click(menuButton('Task'))
    const item = within(screen.getByRole('menu')).getByRole('menuitem', { name: /Set column formula/ })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveTextContent('The primary column cannot have a column formula')
  })

  it('sets a formula from the menu: rows without their own value show the result, the others keep theirs', async () => {
    const { user, store } = await renderGrid()
    const dialog = await setColumnFormula(user, 'Total', '=[Qty]@row*[Rate]@row')
    await user.click(within(dialog).getByRole('button', { name: 'Set formula' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(store.getState().data!.columns.find((c) => c.id === 'total')!.formula).toBe('=[Qty]@row*[Rate]@row')
    expect(cell(1, 'Total')).toHaveTextContent('20')
    expect(cell(2, 'Total')).toHaveTextContent('1003') // its own formula wins
    expect(cell(3, 'Total')).toHaveTextContent('8')
  })

  it('results update when a dependency changes', async () => {
    const { user, store } = await renderGrid()
    const dialog = await setColumnFormula(user, 'Total', '=[Qty]*[Rate]')
    await user.click(within(dialog).getByRole('button', { name: 'Set formula' }))
    expect(cell(1, 'Total')).toHaveTextContent('20')
    store.getState().setCell('r1', 'qty', '5')
    expect(await screen.findByText('50', { selector: '.cell-text' })).toBeInTheDocument()
    expect(cell(1, 'Total')).toHaveTextContent('50')
  })

  it('the bar shows the column formula in a cell that uses it; editing it makes the cell\'s own value', async () => {
    const { user, store } = await renderGrid()
    const dialog = await setColumnFormula(user, 'Total', '=[Qty]*[Rate]')
    await user.click(within(dialog).getByRole('button', { name: 'Set formula' }))
    await user.click(cell(3, 'Total'))
    expect(bar()).toHaveValue('=[Qty]*[Rate]')
    expect(screen.getByText('Column formula')).toBeInTheDocument()
    await user.clear(bar())
    await user.type(bar(), '42{Enter}')
    expect(store.getState().data!.rows[2].cells.total).toBe(42)
    expect(cell(3, 'Total')).toHaveTextContent('42')
    expect(screen.queryByText('Column formula')).not.toBeInTheDocument()
  })

  it('double-clicking a cell that uses the column formula opens the editor with it; Enter unchanged saves nothing', async () => {
    const { user, persistence } = await renderGrid()
    const dialog = await setColumnFormula(user, 'Total', '=[Qty]*[Rate]')
    await user.click(within(dialog).getByRole('button', { name: 'Set formula' }))
    await user.dblClick(cell(1, 'Total'))
    const editor = screen.getAllByRole('textbox', { name: 'Total' })[0]
    expect(editor).toHaveValue('=[Qty]*[Rate]')
    await user.keyboard('{Enter}')
    await new Promise((r) => setTimeout(r, 0))
    expect(persistence.saveCell).not.toHaveBeenCalled()
  })

  it('shows a live preview of the first row, and syntax errors, while typing', async () => {
    const { user } = await renderGrid()
    const dialog = await setColumnFormula(user, 'Total', '=[Qty]*[Rate]')
    expect(within(dialog).getByTestId('formula-preview')).toHaveTextContent('Row 1 → 20')
    const area = within(dialog).getByRole('combobox', { name: 'Formula' })
    await user.clear(area)
    await user.type(area, '=[[Qty]/0')
    expect(within(dialog).getByTestId('formula-preview')).toHaveTextContent('#DIVIDE BY ZERO')
    await user.clear(area)
    await user.type(area, '=1+')
    expect(within(dialog).getByTestId('formula-preview')).toHaveTextContent('#UNPARSEABLE')
    expect(within(dialog).getByRole('combobox', { name: 'Formula' })).toBeInvalid()
  })

  it('autocompletes function names with a one-line signature; Tab inserts NAME(', async () => {
    const { user } = await renderGrid()
    await user.click(menuButton('Total'))
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Set column formula' }))
    const dialog = screen.getByRole('dialog')
    const area = within(dialog).getByRole('combobox', { name: 'Formula' })
    await user.type(area, '=ROUN')
    const options = within(dialog).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('ROUND(number, [digits])'),
      expect.stringContaining('ROUNDDOWN(number, [digits])'),
      expect.stringContaining('ROUNDUP(number, [digits])'),
    ])
    await user.keyboard('{ArrowDown}{Tab}')
    expect(area).toHaveValue('=ROUNDDOWN(')
    // No suggestions inside a string or a column title.
    await user.type(area, '"SU')
    expect(within(dialog).queryAllByRole('option')).toHaveLength(0)
  })

  it('Enter in the text area saves, and a formula that cannot be read is refused with a message', async () => {
    const { user, store } = await renderGrid()
    const dialog = await setColumnFormula(user, 'Total', '=1+')
    await user.keyboard('{Enter}')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('#UNPARSEABLE')
    expect(store.getState().data!.columns.find((c) => c.id === 'total')!.formula).toBeUndefined()
    const area = within(dialog).getByRole('combobox', { name: 'Formula' })
    await user.type(area, '2{Enter}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(store.getState().data!.columns.find((c) => c.id === 'total')!.formula).toBe('=1+2')
  })

  it('Escape closes the suggestions first, then the dialog', async () => {
    const { user } = await renderGrid()
    const dialog = await setColumnFormula(user, 'Total', '=SU')
    expect(within(dialog).getAllByRole('option').length).toBeGreaterThan(0)
    await user.keyboard('{Escape}')
    expect(within(dialog).queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('"Clear column formula" removes it; the cells that used it go empty again', async () => {
    const { user, store } = await renderGrid()
    const dialog = await setColumnFormula(user, 'Total', '=[Qty]*[Rate]')
    await user.click(within(dialog).getByRole('button', { name: 'Set formula' }))
    await user.click(menuButton('Total'))
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Edit column formula' })).toBeInTheDocument()
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Clear column formula' }))
    expect(store.getState().data!.columns.find((c) => c.id === 'total')!.formula).toBeUndefined()
    expect(cell(1, 'Total')).toHaveTextContent(/^$/)
  })

  it('a checkbox column with a column formula shows a read-only computed checkbox', async () => {
    const { user, store } = await renderGrid()
    const dialog = await setColumnFormula(user, 'OK', '=[Qty]>2')
    await user.click(within(dialog).getByRole('button', { name: 'Set formula' }))
    const box = (row: number) => within(cell(row, 'OK')).getByRole('checkbox')
    expect(box(1)).not.toBeChecked()
    expect(box(3)).toBeChecked()
    expect(box(3)).toBeDisabled()
    await user.click(cell(3, 'OK'))
    await user.keyboard('{Enter}') // does not toggle it
    expect(store.getState().data!.rows[2].cells.ok).toBeUndefined()
  })

  it('Delete on a cell that only shows the column formula does not write anything', async () => {
    const { user, persistence } = await renderGrid()
    const dialog = await setColumnFormula(user, 'Total', '=[Qty]*[Rate]')
    await user.click(within(dialog).getByRole('button', { name: 'Set formula' }))
    await user.click(cell(1, 'Total'))
    await user.keyboard('{Backspace}')
    await new Promise((r) => setTimeout(r, 0))
    expect(persistence.saveCell).not.toHaveBeenCalled()
    expect(cell(1, 'Total')).toHaveTextContent('20')
  })
})
