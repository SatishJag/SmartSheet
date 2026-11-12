import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { addUser, createFakeSupabase, emptyState, FAKE_STORAGE_KEY, type StorageLike } from '../../e2e/support/fakeSupabase'
import { SheetList } from './SheetList'

function setup() {
  const state = emptyState()
  const user = addUser(state, 'import@example.com', 'import-password')
  state.sessionUserId = user.id
  const map = new Map([[FAKE_STORAGE_KEY, JSON.stringify(state)]])
  const storage: StorageLike = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
  const client = createFakeSupabase({ storage }) as unknown as SupabaseClient
  const onOpen = vi.fn()
  render(<SheetList client={client} userId={user.id} onOpen={onOpen} />)
  return { client, onOpen, user: userEvent.setup() }
}

const csvFile = (text: string, name = 'Punch list.csv') => new File([text], name, { type: 'text/csv' })

describe('SheetList import CSV', () => {
  it('creates a sheet with typed columns and rows from the file and opens it', async () => {
    const { client, onOpen, user } = setup()
    await user.upload(await screen.findByLabelText('Import CSV'), csvFile('Task,Due\r\nPour,2026-03-01\r\n"Frame, wall",2026-03-02\r\n'))
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1))
    const sheetId = onOpen.mock.calls[0][0]
    const sheets = (await client.from('sheets').select('id,name')).data as { id: string; name: string }[]
    expect(sheets).toEqual([{ id: sheetId, name: 'Punch list' }])
    const cols = (await client.from('columns').select('title,type,position').eq('sheet_id', sheetId).order('position')).data
    expect(cols).toEqual([
      { title: 'Task', type: 'TEXT_NUMBER', position: 0 },
      { title: 'Due', type: 'DATE', position: 1 },
    ])
    const rows = (await client.from('rows').select('position,cells').eq('sheet_id', sheetId).order('position')).data as {
      cells: Record<string, unknown>
    }[]
    expect(rows.map((r) => Object.values(r.cells))).toEqual([
      ['Pour', '2026-03-01'],
      ['Frame, wall', '2026-03-02'],
    ])
  })

  it('shows an alert and creates nothing for a file over the limit or with a bad quote', async () => {
    const { client, onOpen, user } = setup()
    const input = await screen.findByLabelText('Import CSV')
    await user.upload(input, csvFile('A\n' + '1\n'.repeat(5001), 'big.csv'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not import "big.csv": This file has 5001 rows; the import limit is 5000')
    await user.upload(input, csvFile('A\n"oops\n', 'bad.csv'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not import "bad.csv"'))
    expect(onOpen).not.toHaveBeenCalled()
    expect((await client.from('sheets').select('id')).data).toEqual([])
  })
})
