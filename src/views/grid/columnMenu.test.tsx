import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SheetData } from '../../store/persistence'
import { SheetStoreProvider } from '../../store/SheetStoreContext'
import { COL, makeSheetData, makeTestStore } from '../../test/fixtures'
import { GridView } from './GridView'

async function renderGrid(data: SheetData = makeSheetData()) {
  const { store, persistence } = await makeTestStore(data)
  const user = userEvent.setup()
  render(
    <SheetStoreProvider store={store}>
      <GridView viewportHeight={600} />
    </SheetStoreProvider>,
  )
  return { store, persistence, user }
}

const headerTitles = () => screen.getAllByRole('columnheader').map((h) => h.textContent)
const menuButton = (title: string) => screen.getByRole('button', { name: `Column menu for ${title}` })
const item = (name: string | RegExp) => within(screen.getByRole('menu')).getByRole('menuitem', { name })

async function openMenu(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(menuButton(title))
  expect(screen.getByRole('menu', { name: `${title} column` })).toBeInTheDocument()
}

describe('column header menu', () => {
  it('opens from the header button with the column actions, and Escape closes it', async () => {
    const { user } = await renderGrid()
    await openMenu(user, 'Status')
    expect(menuButton('Status')).toHaveAttribute('aria-expanded', 'true')
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Rename column',
      'Insert column left',
      'Insert column right',
      'Edit dropdown options',
      'Change column type',
      'Delete column',
    ])
    expect(item('Rename column')).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(item('Insert column left')).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(menuButton('Status')).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps the header text equal to the column title (the menu icon is drawn by CSS)', async () => {
    await renderGrid()
    expect(headerTitles()).toContain('Status')
  })

  it('a click outside closes the menu', async () => {
    const { user } = await renderGrid()
    await openMenu(user, 'Status')
    await user.click(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('explains why the primary and schedule columns cannot be deleted or retyped', async () => {
    const { user, store } = await renderGrid()
    await openMenu(user, 'Task')
    expect(item(/^Delete column/)).toHaveAttribute('aria-disabled', 'true')
    expect(item(/^Delete column/)).toHaveTextContent('The primary column cannot be deleted')
    expect(item(/^Insert column left/)).toHaveAttribute('aria-disabled', 'true')
    await user.click(item(/^Delete column/))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await user.keyboard('{Escape}')

    await openMenu(user, 'Start')
    expect(item(/^Change column type/)).toHaveAttribute('aria-disabled', 'true')
    expect(item(/^Change column type/)).toHaveTextContent(/used for scheduling/)
    expect(store.getState().data!.columns).toHaveLength(7)
  })

  it('Shift+F10 on a cell opens that column’s menu; Escape returns focus to the cell', async () => {
    const { user } = await renderGrid()
    const cell = screen.getAllByRole('gridcell').find((c) => c.dataset.rowId === 'r-site' && c.dataset.colId === COL.status)!
    await user.click(cell)
    await user.keyboard('{Shift>}{F10}{/Shift}')
    expect(screen.getByRole('menu', { name: 'Status column' })).toBeInTheDocument()
    expect(item('Rename column')).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(cell).toHaveFocus()
    expect(cell).toHaveAttribute('aria-selected', 'true')
  })
})

describe('column actions from the header', () => {
  it('renames a column in place; a duplicate name shows an error and Escape cancels', async () => {
    const { user, store } = await renderGrid()
    await openMenu(user, 'Status')
    await user.click(item('Rename column'))
    const input = screen.getByRole('textbox', { name: 'Rename column Status' })
    expect(input).toHaveFocus()
    await user.clear(input)
    await user.type(input, 'task{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('A column named "Task" already exists')
    await user.clear(input)
    await user.type(input, 'Stage{Enter}')
    expect(screen.queryByRole('textbox', { name: /Rename column/ })).not.toBeInTheDocument()
    expect(headerTitles()).toContain('Stage')
    expect(store.getState().data!.columns.find((c) => c.id === COL.status)!.title).toBe('Stage')

    await openMenu(user, 'Stage')
    await user.click(item('Rename column'))
    await user.keyboard('Other{Escape}')
    expect(headerTitles()).toContain('Stage')
  })

  it('inserts a column to the right through the dialog', async () => {
    const { user } = await renderGrid()
    await openMenu(user, 'Task')
    await user.click(item('Insert column right'))
    const dialog = screen.getByRole('dialog', { name: 'Add column' })
    expect(within(dialog).getByLabelText('Column name')).toHaveFocus()
    await user.type(within(dialog).getByLabelText('Column name'), 'Trade')
    await user.click(within(dialog).getByRole('button', { name: 'Add column' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(headerTitles().slice(0, 4)).toEqual(['', 'Task', 'Trade', 'Start'])
  })

  it('inserts a column to the left of another', async () => {
    const { user } = await renderGrid()
    await openMenu(user, 'Status')
    await user.click(item('Insert column left'))
    await user.type(screen.getByLabelText('Column name'), 'Notes{Enter}')
    expect(headerTitles().slice(-2)).toEqual(['Notes', 'Status'])
  })

  it('the add-column button appends a dropdown column; options are required', async () => {
    const { user, store } = await renderGrid()
    await user.click(screen.getByRole('button', { name: 'Add column' }))
    const dialog = screen.getByRole('dialog', { name: 'Add column' })
    await user.type(within(dialog).getByLabelText('Column name'), 'Trade')
    await user.selectOptions(within(dialog).getByLabelText('Column type'), 'Dropdown (single)')
    await user.click(within(dialog).getByRole('button', { name: 'Add column' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Add at least one option')
    await user.type(within(dialog).getByLabelText('Options (one per line)'), 'Electrical{Enter}Plumbing')
    await user.click(within(dialog).getByRole('button', { name: 'Add column' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(headerTitles().at(-1)).toBe('Trade')
    expect(store.getState().data!.columns.at(-1)).toMatchObject({ type: 'PICKLIST', options: ['Electrical', 'Plumbing'] })
  })

  it('Escape cancels the add-column dialog and returns focus to the button', async () => {
    const { user } = await renderGrid()
    const add = screen.getByRole('button', { name: 'Add column' })
    await user.click(add)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(add).toHaveFocus()
    expect(headerTitles()).toHaveLength(8)
  })

  it('edits dropdown options', async () => {
    const { user, store } = await renderGrid()
    await openMenu(user, 'Status')
    await user.click(item('Edit dropdown options'))
    const dialog = screen.getByRole('dialog', { name: 'Edit dropdown options: Status' })
    const options = within(dialog).getByLabelText('Options (one per line)')
    expect(options).toHaveValue('Not started\nIn progress\nDone')
    await user.type(options, '{Enter}Blocked')
    await user.click(within(dialog).getByRole('button', { name: 'Save options' }))
    expect(store.getState().data!.columns.find((c) => c.id === COL.status)!.options).toEqual([
      'Not started',
      'In progress',
      'Done',
      'Blocked',
    ])
  })

  it('changes a column type and shows how many values were cleared', async () => {
    const { user, store } = await renderGrid()
    await openMenu(user, 'Status')
    await user.click(item('Change column type'))
    const dialog = screen.getByRole('dialog', { name: 'Change column type: Status' })
    expect(within(dialog).getByLabelText('Column type')).toHaveValue('PICKLIST')
    await user.selectOptions(within(dialog).getByLabelText('Column type'), 'Date')
    await user.click(within(dialog).getByRole('button', { name: 'Change type' }))
    expect(store.getState().data!.columns.find((c) => c.id === COL.status)!.type).toBe('DATE')
    expect(store.getState().notices).toEqual(['Changed "Status" to Date: cleared 3 values that did not fit'])
  })

  it('deletes a column after confirmation; Cancel keeps it', async () => {
    const { user, store } = await renderGrid()
    await openMenu(user, 'Status')
    await user.click(item('Delete column'))
    const confirm = screen.getByRole('alertdialog', { name: 'Delete column' })
    expect(confirm).toHaveTextContent('Delete the "Status" column and all of its values?')
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(headerTitles()).toContain('Status')

    await openMenu(user, 'Status')
    await user.click(item('Delete column'))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete column' }))
    expect(headerTitles()).not.toContain('Status')
    expect(store.getState().data!.rows.every((r) => !(COL.status in r.cells))).toBe(true)
  })
})
