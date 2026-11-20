import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createSupabaseClient } from './lib/supabase'
import { supabasePersistence } from './store/persistence'
import { makeFakePersistence } from './test/fixtures'

vi.mock('./lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/supabase')>()),
  createSupabaseClient: vi.fn(),
}))

vi.mock('./store/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store/persistence')>()),
  supabasePersistence: vi.fn(),
}))

afterEach(() => {
  vi.unstubAllEnvs()
})

// These tests mount the whole app (auth, list, sheet, grid); on a loaded full run the default
// 1 s wait for each step is not always enough.
const SLOW = { timeout: 10_000 }
vi.setConfig({ testTimeout: 30_000 })

/** A client with a signed-in session whose sheet list holds one sheet. */
function fakeClient(): SupabaseClient {
  const session = { access_token: 't', user: { id: 'user-1', email: 'pm@example.com' } }
  const list = { data: [{ id: 'sheet-1', name: 'Tower A', created_at: '2026-11-09T00:00:00Z' }], error: null }
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
    from: vi.fn(() => {
      const ordered = { order: () => ordered, range: () => Promise.resolve(list) }
      return { select: () => ordered }
    }),
  } as unknown as SupabaseClient
}

describe('App', () => {
  it('shows the not-configured screen when Supabase env is missing', () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
    render(<App />)
    expect(screen.getByText('Supabase is not configured')).toBeInTheDocument()
    expect(screen.getByText('VITE_SUPABASE_URL')).toBeInTheDocument()
    expect(screen.getByText('VITE_SUPABASE_ANON_KEY')).toBeInTheDocument()
  })

  it('opens a sheet in the sheet view and goes back to the list', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')
    vi.mocked(createSupabaseClient).mockReturnValue(fakeClient())
    vi.mocked(supabasePersistence).mockReturnValue(makeFakePersistence())
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: /^Tower A/ }, SLOW))
    expect(await screen.findByRole('grid', {}, SLOW)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Tower A' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Back to sheets' }))
    expect(await screen.findByRole('heading', { name: 'Your sheets' }, SLOW)).toBeInTheDocument()
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
  })

  it('shows the signed-in e-mail and a Sign out button in the header', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')
    vi.mocked(createSupabaseClient).mockReturnValue(fakeClient())
    vi.mocked(supabasePersistence).mockReturnValue(makeFakePersistence())
    render(<App />)
    expect(await screen.findByRole('button', { name: /^Tower A/ }, SLOW)).toBeInTheDocument()
    const account = screen.getByRole('button', { name: 'Account: pm@example.com' })
    fireEvent.click(account)
    expect(screen.getByText('pm@example.com')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })
})
