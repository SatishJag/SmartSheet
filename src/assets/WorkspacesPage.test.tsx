import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { emptyReportDefinition } from './definition'
import { renderAssets } from './testRender'
import { WorkspacesPage } from './WorkspacesPage'

async function open(sheets = ['Plan A', 'Plan B']) {
  const ctx = renderAssets(<WorkspacesPage />, sheets)
  await screen.findByRole('heading', { name: 'Workspaces' })
  await screen.findByText('Not in a workspace')
  return { ...ctx, user: userEvent.setup() }
}

async function menu(user: ReturnType<typeof userEvent.setup>, buttonName: string, item: string) {
  await user.click(screen.getByRole('button', { name: buttonName }))
  await user.click(await screen.findByRole('menuitem', { name: item }))
}

async function prompt(user: ReturnType<typeof userEvent.setup>, dialogName: string, text: string, confirm: string) {
  const dialog = await screen.findByRole('dialog', { name: dialogName })
  const input = within(dialog).getByRole('textbox')
  await user.clear(input)
  await user.type(input, text)
  await user.click(within(dialog).getByRole('button', { name: confirm }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}

describe('WorkspacesPage', () => {
  it('lists unplaced sheets, creates a workspace with a folder, and moves a sheet into the folder', async () => {
    const { user, store } = await open()
    expect(screen.getByText('No workspaces yet')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Not in a workspace' })).toHaveTextContent('Plan A')

    await user.click(screen.getByRole('button', { name: 'New workspace' }))
    await prompt(user, 'New workspace', 'Riverside', 'Create')
    const card = await screen.findByRole('region', { name: 'Riverside' })
    expect(card).toHaveTextContent('Nothing here yet')

    await menu(user, 'Add to Riverside', 'New folder')
    await prompt(user, 'New folder', 'Programmes', 'Create')
    expect(await screen.findByRole('button', { name: 'Programmes 0' })).toBeInTheDocument()

    await menu(user, 'Actions for Plan A', 'Move to workspace…')
    const move = await screen.findByRole('dialog', { name: 'Move "Plan A"' })
    await user.selectOptions(within(move).getByRole('combobox'), within(move).getByRole('option', { name: /Programmes/ }))
    await user.click(within(move).getByRole('button', { name: 'Move' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(screen.getByRole('region', { name: 'Not in a workspace' })).not.toHaveTextContent('Plan A')
    expect(within(screen.getByRole('region', { name: 'Riverside' })).getByText('Plan A')).toBeInTheDocument()
    expect(store.getState().placements).toMatchObject([{ assetType: 'sheet', folderId: store.getState().folders[0].id }])
  })

  it('opens a sheet in the Sheets section', async () => {
    const { user, openSheet, sheetIds } = await open()
    await user.click(within(screen.getByRole('region', { name: 'Not in a workspace' })).getByRole('button', { name: 'Plan B Sheet' }))
    expect(openSheet).toHaveBeenCalledWith(sheetIds[1])
  })

  it('stars and unstars, and shows favorites at the top', async () => {
    const { user } = await open()
    await user.click(screen.getByRole('button', { name: 'Add Plan A to favorites' }))
    const favorites = await screen.findByRole('region', { name: 'Favorites' })
    expect(within(favorites).getByRole('button', { name: /Plan A/ })).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Remove Plan A from favorites' })[0])
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Favorites' })).toBeNull())
  })

  it('searches every asset by name, and says when nothing matches', async () => {
    const { user, store } = await open(['Plan A', 'Plan B', 'Site log'])
    await store.getState().createReport('Overdue plans', emptyReportDefinition())
    await screen.findByText('Not in a workspace')
    const box = screen.getByRole('searchbox')
    await user.type(box, 'plan')
    const results = await screen.findByRole('region', { name: 'Search results' })
    expect(within(results).getAllByRole('listitem').map((li) => li.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Plan A'), expect.stringContaining('Plan B'), expect.stringContaining('Overdue plans')]),
    )
    expect(results).not.toHaveTextContent('Site log')
    await user.clear(box)
    await user.type(box, 'zzz')
    expect(await screen.findByText('Nothing matches "zzz".')).toBeInTheDocument()
  })

  it('renames and deletes a workspace after confirming; its sheets are kept', async () => {
    const { user, store } = await open()
    await user.click(screen.getByRole('button', { name: 'New workspace' }))
    await prompt(user, 'New workspace', 'Temp', 'Create')
    await screen.findByRole('region', { name: 'Temp' })
    await menu(user, 'Actions for workspace Temp', 'Rename')
    await prompt(user, 'Rename workspace', 'Depot', 'Rename')
    await screen.findByRole('region', { name: 'Depot' })

    await menu(user, 'Actions for workspace Depot', 'Delete workspace')
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete workspace' })
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Depot' })).toBeNull())
    expect(store.getState().sheets).toHaveLength(2)
  })

  it('shows an error from the backend instead of failing silently', async () => {
    const { user } = await open()
    await user.click(screen.getByRole('button', { name: 'New workspace' }))
    const dialog = await screen.findByRole('dialog', { name: 'New workspace' })
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter a workspace name')
  })
})
