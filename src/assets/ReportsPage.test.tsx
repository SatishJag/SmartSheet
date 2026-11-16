import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ReportsPage } from './ReportsPage'
import { renderAssets } from './testRender'

const SITE = {
  name: 'Site works',
  columns: [['Task'], ['Status', 'PICKLIST', ['Open', 'Done']], ['Cost']] as [string, ('PICKLIST' | undefined)?, string[]?][],
  rows: [
    ['Dig trench', 'Open', 1200],
    ['Pour slab', 'Done', 3400],
    ['Frame walls', 'Open', 800],
  ],
}
const FIT = {
  name: 'Fit-out',
  columns: [['task'], ['Status', 'PICKLIST', ['Open', 'Blocked']], ['Cost']] as [string, ('PICKLIST' | undefined)?, string[]?][],
  rows: [
    ['Hang doors', 'Open', 300],
    ['Paint', 'Blocked', 450],
  ],
}

async function buildReport(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: 'Reports' })
  await user.click(screen.getByRole('button', { name: 'New report' }))
  const dialog = await screen.findByRole('dialog', { name: 'New report' })
  await user.type(within(dialog).getByRole('textbox'), 'Open work')
  await user.click(within(dialog).getByRole('button', { name: 'Create and set up' }))

  await screen.findByText('1. Sheets to pull rows from')
  await user.click(screen.getByRole('checkbox', { name: 'Site works' }))
  await user.click(screen.getByRole('checkbox', { name: 'Fit-out' }))
  // The first columns of the chosen sheets are filled in once they load.
  await screen.findByRole('button', { name: 'Remove Task' })
  await screen.findByText(/rows match/)
  expect(screen.getByRole('button', { name: 'Remove Status' })).toBeInTheDocument()
}

describe('ReportsPage', () => {
  it('builds a report over two sheets, filters it, and saves it', async () => {
    const { user, store } = Object.assign(renderAssets(<ReportsPage />, [SITE, FIT]), { user: userEvent.setup() })
    await buildReport(user)
    expect(screen.getByText('5 rows match. Showing the first 50.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    await user.selectOptions(screen.getByLabelText('Filter 1 column'), 'Status')
    await user.selectOptions(screen.getByLabelText('Filter 1 value'), 'Open')
    await waitFor(() => expect(screen.getByText('3 rows match. Showing the first 50.')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Save report' }))
    await screen.findByRole('button', { name: 'Edit report' })
    const saved = store.getState().reports[0]
    expect(saved.name).toBe('Open work')
    expect(saved.definition.sources).toHaveLength(2)
    expect(saved.definition.filter.conditions).toEqual([{ column: 'c:status', op: 'is', value: 'Open', value2: '' }])
    expect(await screen.findByText(/3 of 5 rows from 2 sheets/)).toBeInTheDocument()
  })

  it('edits a cell in place, writes it to the source sheet, and the row leaves the filtered report', async () => {
    const ctx = renderAssets(<ReportsPage />, [SITE, FIT])
    const user = userEvent.setup()
    await buildReport(user)
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    await user.selectOptions(screen.getByLabelText('Filter 1 column'), 'Status')
    await user.selectOptions(screen.getByLabelText('Filter 1 value'), 'Open')
    await user.click(screen.getByRole('button', { name: 'Save report' }))
    await screen.findByText(/3 of 5 rows from 2 sheets/)

    const grid = screen.getByRole('grid', { name: 'Open work rows' })
    expect(within(grid).getByText('Hang doors')).toBeInTheDocument()

    // Hang doors is in the Fit-out sheet, whose Status column allows Open and Blocked.
    const row = within(grid).getByText('Hang doors').closest('[role="row"]') as HTMLElement
    const statusCell = within(row).getByText('Open').closest('[role="gridcell"]') as HTMLElement
    await user.click(statusCell)
    const select = await within(row).findByRole('combobox', { name: /Status, Fit-out row 1/ })
    await user.selectOptions(select, 'Blocked')
    await user.keyboard('{Enter}')

    await waitFor(() => expect(within(grid).queryByText('Hang doors')).toBeNull())
    expect(screen.getByText(/2 of 5 rows from 2 sheets/)).toBeInTheDocument()

    // The edit really went to the Fit-out sheet and is saved in the database.
    await waitFor(() => {
      const stored = ctx.table('rows').find((r) => r.id === ctx.rowIds[1][0])!
      expect((stored.cells as Record<string, unknown>)[ctx.columnIds[1][1]]).toBe('Blocked')
    })
  })

  it("refuses a value the source column does not allow: the sheet's own message shows, the cell stays open, nothing is saved", async () => {
    const ctx = renderAssets(<ReportsPage />, [SITE, FIT])
    const user = userEvent.setup()
    await buildReport(user)
    await user.click(screen.getByRole('button', { name: 'Save report' }))
    await screen.findByText(/5 of 5 rows from 2 sheets/)
    const grid = screen.getByRole('grid', { name: 'Open work rows' })

    // The report column offers every option of both sheets, but Fit-out's Status does not allow "Done".
    const row = within(grid).getByText('Paint').closest('[role="row"]') as HTMLElement
    await user.click(within(row).getByText('Blocked'))
    const select = await within(row).findByRole('combobox')
    await user.selectOptions(select, 'Done')
    await user.keyboard('{Enter}')

    expect(await screen.findByRole('alert')).toHaveTextContent(/Status \(Fit-out, row 2\): Choose one of: Open, Blocked/)
    expect(within(row).getByRole('combobox')).toBeInTheDocument()
    const stored = ctx.table('rows').find((r) => r.id === ctx.rowIds[1][1])!
    expect((stored.cells as Record<string, unknown>)[ctx.columnIds[1][1]]).toBe('Blocked')

    // Escape gives up the edit.
    await user.keyboard('{Escape}')
    expect(within(row).queryByRole('combobox')).toBeNull()
  })

  it('exports the rows as CSV', async () => {
    const created: string[] = []
    const realCreate = URL.createObjectURL
    URL.createObjectURL = (b: Blob | MediaSource) => {
      void (b as Blob).text().then((t) => created.push(t))
      return 'blob:test'
    }
    try {
      const ctx = renderAssets(<ReportsPage />, [SITE])
      const user = userEvent.setup()
      await screen.findByRole('heading', { name: 'Reports' })
      await user.click(screen.getByRole('button', { name: 'New report' }))
      await user.type(within(await screen.findByRole('dialog')).getByRole('textbox'), 'Costs')
      await user.click(screen.getByRole('button', { name: 'Create and set up' }))
      await user.click(await screen.findByRole('checkbox', { name: 'Site works' }))
      await screen.findByRole('button', { name: 'Remove Task' })
      await user.click(screen.getByRole('button', { name: 'Save report' }))
      await user.click(await screen.findByRole('button', { name: 'Export CSV' }))
      await waitFor(() => expect(created).toHaveLength(1))
      expect(created[0]).toContain('Task,Status,Cost')
      expect(created[0]).toContain('Dig trench,Open,1200')
      void ctx
    } finally {
      URL.createObjectURL = realCreate
    }
  })

  it('deletes a report after confirming', async () => {
    const ctx = renderAssets(<ReportsPage />, [SITE])
    const user = userEvent.setup()
    await ctx.store.getState().createReport('Temp')
    await screen.findByText('Temp')
    await user.click(screen.getByRole('button', { name: 'Actions for Temp' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete report' })
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText('Temp')).toBeNull())
    expect(await screen.findByText('No reports yet')).toBeInTheDocument()
  })
})
