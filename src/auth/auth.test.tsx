import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    signInWithPassword: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    signUp: vi.fn().mockResolvedValue({ data: { session: null, user: null }, error: null }),
  }
  const client = { auth } as unknown as SupabaseClient
  return {
    client,
    auth,
    unsubscribe,
    deliver: (event: string, session: Session | null) => act(() => callback(event, session)),
  }
}

function fillAndSubmit(email: string, password: string, buttonName: string) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: buttonName }))
}

describe('AuthGate', () => {
  it('shows the sign-in form when there is no session', async () => {
    const { client } = makeAuthClient()
    const children = vi.fn(() => <p>app content</p>)
    render(<AuthGate client={client}>{children}</AuthGate>)

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(children).not.toHaveBeenCalled()
  })

  it('shows a loading state while the initial session is read', async () => {
    const { client } = makeAuthClient()
    render(<AuthGate client={client}>{() => <p>app content</p>}</AuthGate>)
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    await screen.findByLabelText('Email')
  })

  it('renders children immediately when a session already exists', async () => {
    const { client } = makeAuthClient(fakeSession)
    render(<AuthGate client={client}>{(s) => <p>hello {s.user.email}</p>}</AuthGate>)
    expect(await screen.findByText('hello test@example.com')).toBeInTheDocument()
  })

  it('renders children after sign-in delivers a session', async () => {
    const { client, auth, deliver } = makeAuthClient()
    render(<AuthGate client={client}>{(s) => <p>hello {s.user.email}</p>}</AuthGate>)

    await screen.findByLabelText('Email')
    fillAndSubmit('test@example.com', 'not-a-real-password', 'Sign in')

    await waitFor(() =>
      expect(auth.signInWithPassword).toHaveBeenCalledWith({
        email: 'test@example.com',
        password: 'not-a-real-password',
      }),
    )
    deliver('SIGNED_IN', fakeSession)
    expect(await screen.findByText('hello test@example.com')).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
  })

  it('shows the auth error message in an alert', async () => {
    const { client, auth } = makeAuthClient()
    auth.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { message: 'Invalid login credentials' },
    })
    render(<AuthGate client={client}>{() => <p>app content</p>}</AuthGate>)

    await screen.findByLabelText('Email')
    fillAndSubmit('test@example.com', 'wrong', 'Sign in')

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid login credentials')
  })

  it('create-account toggle calls signUp and shows the confirm-email message', async () => {
    const { client, auth } = makeAuthClient()
    render(<AuthGate client={client}>{() => <p>app content</p>}</AuthGate>)

    fireEvent.click(await screen.findByRole('button', { name: 'Create account' }))
    fillAndSubmit('new@example.com', 'not-a-real-password', 'Create account')

    await waitFor(() =>
      expect(auth.signUp).toHaveBeenCalledWith({
        email: 'new@example.com',
        password: 'not-a-real-password',
      }),
    )
    expect(auth.signInWithPassword).not.toHaveBeenCalled()
    expect(
      await screen.findByText('Check your email to confirm your account'),
    ).toBeInTheDocument()
  })

  it('unsubscribes from auth changes on unmount', async () => {
    const { client, unsubscribe } = makeAuthClient()
    const { unmount } = render(<AuthGate client={client}>{() => <p>x</p>}</AuthGate>)
    await screen.findByLabelText('Email')
    expect(unsubscribe).not.toHaveBeenCalled()
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
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

    fireEvent.click(await screen.findByRole('button', { name: /Tower A/ }))
    expect(onOpen).toHaveBeenCalledWith('s1')
    expect(screen.getByRole('button', { name: /Tower B/ })).toBeInTheDocument()
    expect(screen.queryByText('No sheets yet')).not.toBeInTheDocument()
  })

  it('shows an alert when listing fails', async () => {
    const { client } = makeSheetsClient({ list: { data: null, error: { message: 'list boom' } } })
    render(<SheetList client={client} userId="user-1" onOpen={() => {}} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('list boom')
  })

  describe('templates', () => {
    const insertTemplate = vi.mocked(insertSheetFromTemplate)

    it('has a Template select with the three templates only, defaulting to Project schedule', async () => {
      const { client } = makeSheetsClient({})
      render(<SheetList client={client} userId="user-1" onOpen={() => {}} />)
      const select = await screen.findByLabelText('Template')
      expect(select).toHaveValue('project-schedule')
      expect(Array.from((select as HTMLSelectElement).options).map((o) => [o.value, o.textContent])).toEqual([
        ['project-schedule', 'Project schedule'],
        ['punch-list', 'Punch list'],
        ['simple-list', 'Simple list'],
      ])
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

      fireEvent.change(await screen.findByLabelText('Template'), { target: { value: 'project-schedule' } })
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

      fireEvent.change(await screen.findByLabelText('Template'), { target: { value: 'punch-list' } })
      fireEvent.click(screen.getByRole('button', { name: 'New sheet' }))

      expect(await screen.findByRole('alert')).toHaveTextContent('tpl boom')
      expect(onOpen).not.toHaveBeenCalled()
    })

    it('disables the button and select while creating, so a double click makes one sheet', async () => {
      insertTemplate.mockReset()
      let resolve!: (id: string) => void
      insertTemplate.mockReturnValue(new Promise<string>((r) => (resolve = r)))
      const onOpen = vi.fn()
      const { client } = makeSheetsClient({})
      render(<SheetList client={client} userId="user-1" onOpen={onOpen} />)

      fireEvent.change(await screen.findByLabelText('Template'), { target: { value: 'punch-list' } })
      const button = screen.getByRole('button', { name: 'New sheet' })
      fireEvent.click(button)
      fireEvent.click(button)

      expect(button).toBeDisabled()
      expect(screen.getByLabelText('Template')).toBeDisabled()
      expect(insertTemplate).toHaveBeenCalledTimes(1)
      resolve('tpl-id')
      await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(button).not.toBeDisabled())
    })
  })
})
