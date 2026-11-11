import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { addUser, createFakeSupabase, emptyState, FAKE_STORAGE_KEY, type StorageLike } from '../../e2e/support/fakeSupabase'
import { validateSheetName } from './sheetName'
import { SheetList } from './SheetList'

/** The e2e fake Supabase with one signed-in user owning the named sheets (and a row in the first). */
function setup(names: string[]) {
  const state = emptyState()
  const user = addUser(state, 'manage@example.com', 'manage-password')
  state.sessionUserId = user.id
  const ids = names.map(() => crypto.randomUUID())
  names.forEach((name, i) =>
    state.tables.sheets.push({
      id: ids[i],
      owner_id: user.id,
      workspace_id: user.id,
      name,
      calendar: { workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 },
      dependencies_enabled: false,
      created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    }),
  )
  state.tables.rows.push({ id: crypto.randomUUID(), sheet_id: ids[0], owner_id: user.id, workspace_id: user.id, parent_id: null, position: 'a0', cells: {}, version: 0 })
  const map = new Map([[FAKE_STORAGE_KEY, JSON.stringify(state)]])
  const storage: StorageLike = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
  const client = createFakeSupabase({ storage }) as unknown as SupabaseClient
  render(<SheetList client={client} userId={user.id} onOpen={() => {}} />)
  return { client, ids, user: userEvent.setup() }
}

async function dbNames(client: SupabaseClient) {
  const { data } = await client.from('sheets').select('name')
  return (data as { name: string }[]).map((s) => s.name).sort()
}

describe('validateSheetName', () => {
  it('trims, requires a name and allows at most 100 characters', () => {
    expect(validateSheetName('  Tower B  ')).toEqual({ ok: true, name: 'Tower B' })
    expect(validateSheetName('   ')).toEqual({ ok: false, error: 'Enter a sheet name' })
    expect(validateSheetName('x'.repeat(100))).toEqual({ ok: true, name: 'x'.repeat(100) })
    expect(validateSheetName('x'.repeat(101))).toEqual({ ok: false, error: 'Sheet names can be at most 100 characters' })
  })
})

describe('SheetList rename', () => {
  it('Rename edits inline; Enter saves to the database and the list', async () => {
    const { client, user } = setup(['Tower A', 'Tower B'])
    await user.click(await screen.findByRole('button', { name: 'Rename Tower A' }))
    const input = screen.getByRole('textbox', { name: 'Sheet name' })
    expect(input).toHaveValue('Tower A')
    expect(input).toHaveFocus()
    await user.clear(input)
    await user.type(input, 'Tower A (east){Enter}')
    expect(await screen.findByRole('button', { name: /^Tower A \(east\)/ })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Sheet name' })).not.toBeInTheDocument()
    expect(await dbNames(client)).toEqual(['Tower A (east)', 'Tower B'])
  })

  it('Escape cancels without saving', async () => {
    const { client, user } = setup(['Tower A'])
    await user.click(await screen.findByRole('button', { name: 'Rename Tower A' }))
    await user.type(screen.getByRole('textbox', { name: 'Sheet name' }), ' changed{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Sheet name' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Tower A/ })).toBeInTheDocument()
    expect(await dbNames(client)).toEqual(['Tower A'])
  })

  it('an empty or too-long name shows an alert and stays in the editor', async () => {
    const { client, user } = setup(['Tower A'])
    await user.click(await screen.findByRole('button', { name: 'Rename Tower A' }))
    const input = screen.getByRole('textbox', { name: 'Sheet name' })
    await user.clear(input)
    await user.keyboard('{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a sheet name')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    await user.type(input, 'x'.repeat(101))
    await user.keyboard('{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('Sheet names can be at most 100 characters')
    expect(await dbNames(client)).toEqual(['Tower A'])
  })
})

describe('SheetList delete', () => {
  it('Delete asks in an accessible dialog naming the sheet; Cancel keeps it', async () => {
    const { client, user } = setup(['Tower A', 'Tower B'])
    await user.click(await screen.findByRole('button', { name: 'Delete Tower A' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Delete sheet' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleDescription('Delete "Tower A" and all of its rows? This cannot be undone.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(await dbNames(client)).toEqual(['Tower A', 'Tower B'])
  })

  it('confirming deletes the sheet (its rows cascade) and refetches the list', async () => {
    const { client, user } = setup(['Tower A', 'Tower B'])
    await user.click(await screen.findByRole('button', { name: 'Delete Tower A' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Tower A/ })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /^Tower B/ })).toBeInTheDocument()
    expect(await dbNames(client)).toEqual(['Tower B'])
    expect((await client.from('rows').select('id')).data).toEqual([])
  })
})
