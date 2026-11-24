import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { KeepSheetsBanner } from './KeepSheetsBanner'

const STRIP = "You're using a guest account: your sheets are only reachable from this browser."

function setup(user: Partial<User>, result: { error: { message: string } | null } = { error: null }) {
  const updateUser = vi.fn(async () => ({ data: { user: null }, ...result }))
  const client = { auth: { updateUser } } as unknown as SupabaseClient
  const full = { id: 'u1', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '', ...user } as User
  const view = render(<KeepSheetsBanner client={client} user={full} />)
  return { updateUser, user: userEvent.setup(), ...view }
}

describe('KeepSheetsBanner', () => {
  it('shows nothing to an email user', () => {
    const { container } = setup({ is_anonymous: false, email: 'a@example.com' })
    expect(container).toBeEmptyDOMElement()
  })

  it('offers a guest to keep their sheets with an email, and sends the link once', async () => {
    const { updateUser, user } = setup({ is_anonymous: true })
    expect(screen.getByText(STRIP)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep my sheets' }))
    await user.click(screen.getByRole('button', { name: 'Send link' }))
    expect(screen.getByText('Enter your email')).toBeInTheDocument()
    expect(updateUser).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Email'), 'planner@example.com')
    await user.dblClick(screen.getByRole('button', { name: 'Send link' }))
    expect(await screen.findByText('Check planner@example.com and open the link in this browser.')).toBeInTheDocument()
    expect(updateUser).toHaveBeenCalledTimes(1)
    expect(updateUser).toHaveBeenCalledWith(
      { email: 'planner@example.com', data: { keep_sheets_email: 'planner@example.com', keep_sheets_password_pending: true } },
      { emailRedirectTo: window.location.origin },
    )
  })

  it('remembers a link already sent, and lets the guest use a different email', async () => {
    const { user } = setup({ is_anonymous: true, user_metadata: { keep_sheets_email: 'old@example.com' } })
    expect(screen.getByText('Check old@example.com and open the link in this browser.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Use a different email' }))
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
  })

  it('says when the email already has an account', async () => {
    const { user } = setup({ is_anonymous: true }, { error: { message: 'A user with this email address has already been registered' } })
    await user.click(screen.getByRole('button', { name: 'Keep my sheets' }))
    await user.type(screen.getByLabelText('Email'), 'taken@example.com')
    await user.click(screen.getByRole('button', { name: 'Send link' }))
    expect(await screen.findByText("That email already has an account. Sheets can't be moved into it yet; use another email.")).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveValue('taken@example.com')
  })

  it('shows any other error as Supabase words it', async () => {
    const { user } = setup({ is_anonymous: true }, { error: { message: 'Manual linking is disabled' } })
    await user.click(screen.getByRole('button', { name: 'Keep my sheets' }))
    await user.type(screen.getByLabelText('Email'), 'planner@example.com')
    await user.click(screen.getByRole('button', { name: 'Send link' }))
    expect(await screen.findByText('Manual linking is disabled')).toBeInTheDocument()
  })

  it('recovers when the request itself fails (review)', async () => {
    const updateUser = vi.fn(async () => {
      throw new Error('Failed to fetch')
    })
    const client = { auth: { updateUser } } as unknown as SupabaseClient
    render(<KeepSheetsBanner client={client} user={{ id: 'u1', app_metadata: {}, user_metadata: {}, aud: '', created_at: '', is_anonymous: true } as User} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Keep my sheets' }))
    await user.type(screen.getByLabelText('Email'), 'planner@example.com')
    await user.click(screen.getByRole('button', { name: 'Send link' }))
    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send link' })).toBeEnabled()
  })

  it('once the email is confirmed, asks for a password and saves it', async () => {
    const { updateUser, user } = setup({
      is_anonymous: false,
      email: 'planner@example.com',
      user_metadata: { keep_sheets_email: 'planner@example.com', keep_sheets_password_pending: true },
    })
    expect(screen.getByText('Set a password so you can sign in anywhere')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Password'), 'short')
    await user.type(screen.getByLabelText('Confirm password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('Use at least 6 characters')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Password'))
    await user.type(screen.getByLabelText('Password'), 'long-enough')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('The passwords do not match')).toBeInTheDocument()
    expect(updateUser).not.toHaveBeenCalled()
    await user.clear(screen.getByLabelText('Confirm password'))
    await user.type(screen.getByLabelText('Confirm password'), 'long-enough')
    await user.dblClick(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved. Sign in with planner@example.com from now on.')).toBeInTheDocument()
    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1))
    expect(updateUser).toHaveBeenCalledWith({ password: 'long-enough', data: { keep_sheets_password_pending: false } })
  })
})
