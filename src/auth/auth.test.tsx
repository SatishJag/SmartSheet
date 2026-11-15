import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { AuthGate } from './AuthGate'
import { insertSheetFromTemplate } from '../templates/insertTemplate'
import { SheetList } from './SheetList'

vi.mock('../templates/insertTemplate', () => ({ insertSheetFromTemplate: vi.fn() }))

const fakeSession = {
  access_token: 'fake-token',
  refresh_token: 'fake-refresh',
  expires_in: 3600,
  token_type: 'bearer',
  user: { id: 'user-1', email: 'test@example.com' },
} as unknown as Session

type AuthCallback = (event: string, session: Session | null) => void

function makeAuthClient(initial: Session | null = null) {
  let callback: AuthCallback = () => {}
  const unsubscribe = vi.fn()
  const auth = {
    getSession: vi.fn().mockResolvedValue({ data: { session: initial }, error: null }),
    onAuthStateChange: vi.fn((cb: AuthCallback) => {
      callback = cb
      return { data: { subscription: { unsubscribe } } }
    }),
    signInAnonymously: vi.fn() as ReturnType<typeof vi.fn>,
  }
  const client = { auth } as unknown as SupabaseClient
  return {
    client,
    auth,
    unsubscribe,
    deliver: (event: string, session: Session | null) => act(() => callback(event, session)),
  }
}

describe('AuthGate (MVP: anonymous sessions, no sign-in screen)', () => {
  const anonSession = { ...fakeSession, user: { id: 'anon-1', email: '', is_anonymous: true } } as unknown as Session

  it('signs a first-time visitor in anonymously and renders the app; no sign-in form', async () => {
    const { client, auth } = makeAuthClient()
    auth.signInAnonymously = vi.fn().mockResolvedValue({ data: { session: anonSession, user: anonSession.user }, error: null })
    const children = vi.fn((s: Session) => <p>app for {s.user.id}</p>)
    render(<AuthGate client={client}>{children}</AuthGate>)
    expect(await screen.findByText('app for anon-1')).toBeInTheDocument()
    expect(auth.signInAnonymously).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
  })

  it('reuses the session a returning visitor already has (no new anonymous user)', async () => {
    const { client, auth } = makeAuthClient(fakeSession)
    auth.signInAnonymously = vi.fn()
    render(<AuthGate client={client}>{() => <p>app content</p>}</AuthGate>)
    expect(await screen.findByText('app content')).toBeInTheDocument()
    expect(auth.signInAnonymously).not.toHaveBeenCalled()
  })

  it('shows a loading state while the session is being set up', async () => {
    const { client, auth } = makeAuthClient()
    auth.signInAnonymously = vi.fn(() => new Promise(() => {}))
    render(<AuthGate client={client}>{() => <p>app content</p>}</AuthGate>)
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    await waitFor(() => expect(auth.signInAnonymously).toHaveBeenCalled())
    expect(screen.queryByText('app content')).not.toBeInTheDocument()
  })

  it('explains how to enable anonymous sign-ins when the project refuses them, and retries', async () => {
    const { client, auth } = makeAuthClient()
    auth.signInAnonymously = vi
      .fn()
      .mockResolvedValueOnce({ data: { session: null, user: null }, error: { message: 'Anonymous sign-ins are disabled' } })
      .mockResolvedValueOnce({ data: { session: anonSession, user: anonSession.user }, error: null })
    render(<AuthGate client={client}>{() => <p>app content</p>}</AuthGate>)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Anonymous sign-ins are disabled')
    expect(alert).toHaveTextContent('Allow anonymous sign-ins')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('app content')).toBeInTheDocument()
    expect(auth.signInAnonymously).toHaveBeenCalledTimes(2)
  })

  it('creates one anonymous user even when effects run twice (StrictMode)', async () => {
    const { client, auth } = makeAuthClient()
    let resolve!: (v: unknown) => void
    auth.signInAnonymously = vi.fn(() => new Promise((r) => (resolve = r)))
    const { unmount } = render(<AuthGate client={client}>{() => <p>app content</p>}</AuthGate>)
    unmount()
    render(<AuthGate client={client}>{() => <p>app content</p>}</AuthGate>)
    await waitFor(() => expect(auth.signInAnonymously).toHaveBeenCalledTimes(1))
    await act(async () => resolve({ data: { session: anonSession, user: anonSession.user }, error: null }))
    expect(await screen.findByText('app content')).toBeInTheDocument()
    expect(auth.signInAnonymously).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes from auth changes on unmount', async () => {
    const { client, unsubscribe } = makeAuthClient(fakeSession)
    const { unmount } = render(<AuthGate client={client}>{() => <p>app content</p>}</AuthGate>)
    await screen.findByText('app content')
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })
})

type Result = { data: unknown; error: { message: string } | null }

function makeSheetsClient(opts: { list?: Result; insert?: Result }) {
  const list = opts.list ?? { data: [], error: null }
  // Pages like PostgREST: .range(from, to) slices the list.
  const range = vi.fn(async (from: number, to: number) =>
    Array.isArray(list.data) ? { data: list.data.slice(from, to + 1), error: null } : list,
  )
  const ordered = { order: vi.fn(() => ordered), range }
  const order = vi.fn(() => ordered)
  const select = vi.fn(() => ({ order }))
  const single = vi.fn().mockResolvedValue(opts.insert ?? { data: { id: 'new-id' }, error: null })
  const insertSelect = vi.fn(() => ({ single }))
  const insert = vi.fn(() => ({ select: insertSelect }))
  const from = vi.fn(() => ({ select, insert }))
  return { client: { from } as unknown as SupabaseClient, from, select, order, range, insert, insertSelect }
}

describe('SheetList', () => {
  it('shows a loading state, then "No sheets yet" for an empty list', async () => {
    const { client, from, select, order } = makeSheetsClient({})
    render(<SheetList client={client} userId="user-1" onOpen={() => {}} />)
    expect(screen.getByText('Loading sheets...')).toBeInTheDocument()
    expect(await screen.findByText('No sheets yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New sheet' })).toBeInTheDocument()
    expect(from).toHaveBeenCalledWith('sheets')
    expect(select).toHaveBeenCalledWith('id,name,created_at')
    expect(order).toHaveBeenCalledWith('created_at', { ascending: false })
  })

  it('pages the sheet list in ranges of 1000 until a short page', async () => {
    const data = Array.from({ length: 1001 }, (_, i) => ({ id: `s${i}`, name: `Sheet ${i}`, created_at: '2026-01-01T00:00:00Z' }))
    const { client, range } = makeSheetsClient({ list: { data, error: null } })
    render(<SheetList client={client} userId="user-1" onOpen={() => {}} />)
    expect(await screen.findByText('Sheet 1000')).toBeInTheDocument()
    expect(document.querySelectorAll('.sheet-item')).toHaveLength(1001)
    expect(range.mock.calls).toEqual([
      [0, 999],
      [1000, 1999],
    ])
  })

  it('lists sheets and opens one on click', async () => {
    const onOpen = vi.fn()
    const { client } = makeSheetsClient({
      list: {
        data: [
          { id: 's2', name: 'Tower B', created_at: '2026-02-01T00:00:00Z' },
          { id: 's1', name: 'Tower A', created_at: '2026-01-01T00:00:00Z' },
        ],
        error: null,
      },
    })
    render(<SheetList client={client} userId="user-1" onOpen={onOpen} />)

    fireEvent.click(await screen.findByRole('button', { name: /^Tower A/ }))
    expect(onOpen).toHaveBeenCalledWith('s1')
    expect(screen.getByRole('button', { name: /^Tower B/ })).toBeInTheDocument()
    expect(screen.queryByText('No sheets yet')).not.toBeInTheDocument()
  })

  it('shows an alert when listing fails', async () => {
    const { client } = makeSheetsClient({ list: { data: null, error: { message: 'list boom' } } })
    render(<SheetList client={client} userId="user-1" onOpen={() => {}} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('list boom')
  })

  describe('templates', () => {
    const insertTemplate = vi.mocked(insertSheetFromTemplate)

    it('has a Template radio group with the three templates only, defaulting to Project schedule', async () => {
      const { client } = makeSheetsClient({})
      render(<SheetList client={client} userId="user-1" onOpen={() => {}} />)
      const group = await screen.findByRole('radiogroup', { name: 'Template' })
      const radios = within(group).getAllByRole('radio') as HTMLInputElement[]
      expect(radios.map((r) => [r.value, r.getAttribute('aria-labelledby') && document.getElementById(r.getAttribute('aria-labelledby')!)?.textContent])).toEqual([
        ['project-schedule', 'Project schedule'],
        ['punch-list', 'Punch list'],
        ['simple-list', 'Simple list'],
      ])
      expect(within(group).getByRole('radio', { name: 'Project schedule' })).toBeChecked()
    })

    it('New sheet with the default creates a Project schedule (never an empty, column-less sheet)', async () => {
      insertTemplate.mockReset()
      insertTemplate.mockResolvedValue('tpl-default')
      const onOpen = vi.fn()
      const { client, insert } = makeSheetsClient({})
      render(<SheetList client={client} userId="user-1" onOpen={onOpen} />)
      fireEvent.click(await screen.findByRole('button', { name: 'New sheet' }))
      await waitFor(() => expect(onOpen).toHaveBeenCalledWith('tpl-default'))
      expect(insertTemplate).toHaveBeenCalledWith(client, 'project-schedule', 'user-1')
      expect(insert).not.toHaveBeenCalled()
    })

    it('creating from a template calls the template insertion and opens the id', async () => {
      insertTemplate.mockReset()
      insertTemplate.mockResolvedValue('tpl-id')
      const onOpen = vi.fn()
      const { client, insert } = makeSheetsClient({})
      render(<SheetList client={client} userId="user-1" onOpen={onOpen} />)

      fireEvent.click(await screen.findByRole('radio', { name: 'Project schedule' }))
      fireEvent.click(screen.getByRole('button', { name: 'New sheet' }))

      await waitFor(() => expect(onOpen).toHaveBeenCalledWith('tpl-id'))
      expect(insertTemplate).toHaveBeenCalledWith(client, 'project-schedule', 'user-1')
      expect(insert).not.toHaveBeenCalled()
    })

    it('shows an alert and does not open when template creation fails', async () => {
      insertTemplate.mockReset()
      insertTemplate.mockRejectedValue(new Error('tpl boom'))
      const onOpen = vi.fn()
      const { client } = makeSheetsClient({})
      render(<SheetList client={client} userId="user-1" onOpen={onOpen} />)

      fireEvent.click(await screen.findByRole('radio', { name: 'Punch list' }))
      fireEvent.click(screen.getByRole('button', { name: 'New sheet' }))

      expect(await screen.findByRole('alert')).toHaveTextContent('tpl boom')
      expect(onOpen).not.toHaveBeenCalled()
    })

    it('disables the button and template cards while creating, so a double click makes one sheet', async () => {
      insertTemplate.mockReset()
      let resolve!: (id: string) => void
      insertTemplate.mockReturnValue(new Promise<string>((r) => (resolve = r)))
      const onOpen = vi.fn()
      const { client } = makeSheetsClient({})
      render(<SheetList client={client} userId="user-1" onOpen={onOpen} />)

      fireEvent.click(await screen.findByRole('radio', { name: 'Punch list' }))
      const button = screen.getByRole('button', { name: 'New sheet' })
      fireEvent.click(button)
      fireEvent.click(button)

      expect(button).toBeDisabled()
      expect(screen.getByRole('radio', { name: 'Punch list' })).toBeDisabled()
      expect(insertTemplate).toHaveBeenCalledTimes(1)
      resolve('tpl-id')
      await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(button).not.toBeDisabled())
    })
  })
})
