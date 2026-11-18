import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { createFakeSupabase, emptyState, FAKE_STORAGE_KEY, type StorageLike } from '../../e2e/support/fakeSupabase'
import { SheetList } from '../auth/SheetList'
import { ShareDialog } from './ShareDialog'

const A = { email: 'owner@example.com', password: 'owner-password' }
const B = { email: 'guest@example.com', password: 'guest-password' }

/** A fake database with two accounts and a sheet owned by A (A is signed in). */
async function setup() {
  const map = new Map([[FAKE_STORAGE_KEY, JSON.stringify(emptyState())]])
  const storage: StorageLike = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
  const fake = createFakeSupabase({ storage })
  const b = await fake.auth.signUp(B)
  const a = await fake.auth.signUp(A)
  const sheet = await fake.from('sheets').insert({ name: 'Tower A' }).select('id').single()
  const client = fake as unknown as SupabaseClient
  return { fake, client, a: a.data.user!.id, b: b.data.user!.id, sheetId: (sheet.data as { id: string }).id }
}

describe('ShareDialog', () => {
  it('shares by email, changes a role, removes the person, and closes with Escape', async () => {
    const { client, sheetId } = await setup()
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ShareDialog client={client} sheetId={sheetId} sheetName="Tower A" onClose={onClose} />)
    expect(await screen.findByText('Not shared with anyone yet')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveFocus()

    await user.type(screen.getByLabelText('Email'), ' Guest@Example.com ')
    await user.click(screen.getByRole('button', { name: 'Share' }))
    const list = await screen.findByRole('list', { name: 'People with access' })
    expect(within(list).getByText(B.email)).toBeInTheDocument()
    expect(screen.getByLabelText('Role for guest@example.com')).toHaveValue('viewer')
    expect(screen.getByLabelText('Email')).toHaveValue('')

    await user.selectOptions(screen.getByLabelText('Role for guest@example.com'), 'editor')
    await waitFor(() => expect(screen.getByLabelText('Role for guest@example.com')).toHaveValue('editor'))

    await user.click(screen.getByRole('button', { name: 'Remove guest@example.com' }))
    expect(await screen.findByText('Not shared with anyone yet')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows why sharing failed: no account, own address, empty address', async () => {
    const { client, sheetId } = await setup()
    const user = userEvent.setup()
    render(<ShareDialog client={client} sheetId={sheetId} sheetName="Tower A" onClose={() => {}} />)
    await screen.findByText('Not shared with anyone yet')
    await user.click(screen.getByRole('button', { name: 'Share' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an email address')
    await user.type(screen.getByLabelText('Email'), 'nobody@example.com')
    await user.click(screen.getByRole('button', { name: 'Share' }))
    expect(await screen.findByText('No account found for nobody@example.com')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Email'))
    await user.type(screen.getByLabelText('Email'), A.email)
    await user.click(screen.getByRole('button', { name: 'Share' }))
    expect(await screen.findByText('You already own this sheet')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveValue(A.email) // kept so it can be corrected
  })
})

describe('SheetList with a shared sheet', () => {
  it('lists it as shared, with no Rename or Delete, while an owned sheet keeps both', async () => {
    const { fake, client, b, sheetId } = await setup()
    await fake.rpc('share_sheet', { p_sheet: sheetId, p_email: B.email, p_role: 'viewer' })
    await fake.auth.signOut()
    await fake.auth.signInWithPassword(B)
    await fake.from('sheets').insert({ name: 'Mine' })
    render(<SheetList client={client} userId={b} onOpen={() => {}} />)
    const shared = await screen.findByRole('button', { name: /^Tower A/ })
    expect(shared).toHaveTextContent('Shared with you')
    expect(screen.getByRole('button', { name: /^Mine/ })).not.toHaveTextContent('Shared with you')
    expect(screen.queryByRole('button', { name: 'Rename Tower A' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete Tower A' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rename Mine' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete Mine' })).toBeInTheDocument()
  })
})
