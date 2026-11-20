import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PublicRequestPage } from './PublicRequestPage'

const TOKEN = 'T'.repeat(43)

type Reply = { status: number; body: unknown }
function mockFetch(...replies: Reply[]) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const r = replies.shift()
      if (!r) throw new Error('unexpected request')
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  return calls
}

afterEach(() => vi.unstubAllGlobals())

const update = {
  ok: true,
  kind: 'update',
  sheetName: 'Tower A',
  message: 'Please update the hours',
  expiresAt: '2026-12-01T00:00:00Z',
  fields: [
    { id: 'h', title: 'Hours', type: 'TEXT_NUMBER', value: 8, editable: true },
    { id: 's', title: 'Status', type: 'PICKLIST', options: ['In progress', 'Done'], value: 'In progress', editable: true },
    { id: 'd', title: 'Done on', type: 'DATE', value: null, editable: true },
    { id: 'ok', title: 'Checked', type: 'CHECKBOX', value: false, editable: true },
    { id: 'f', title: 'Total', type: 'TEXT_NUMBER', value: null, editable: false },
  ],
}

describe('public update page', () => {
  it('shows only the requested fields, sends only what changed, and says thank you', async () => {
    const user = userEvent.setup()
    const calls = mockFetch({ status: 200, body: update }, { status: 200, body: { ok: true } })
    render(<PublicRequestPage kind="u" token={TOKEN} />)
    expect(await screen.findByRole('heading', { name: 'Please update this row' })).toBeInTheDocument()
    expect(screen.getByText('Tower A')).toBeInTheDocument()
    expect(screen.getByText('Please update the hours')).toBeInTheDocument()
    expect(screen.getByLabelText('Hours')).toHaveValue('8')
    expect(screen.getByLabelText(/Total/)).toBeDisabled()
    expect(calls[0].url).toBe(`/api/u/${TOKEN}`)
    expect(calls[0].init?.credentials).toBe('omit')

    await user.click(screen.getByRole('button', { name: 'Send update' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Change at least one value')
    expect(calls).toHaveLength(1)

    await user.clear(screen.getByLabelText('Hours'))
    await user.type(screen.getByLabelText('Hours'), '12')
    await user.selectOptions(screen.getByLabelText('Status'), 'Done')
    await user.click(screen.getByRole('button', { name: 'Send update' }))
    expect(await screen.findByRole('heading', { name: 'Thank you' })).toBeInTheDocument()
    expect(calls[1].init?.method).toBe('POST')
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({ values: { h: '12', s: 'Done' } })
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain('noindex')
  })

  it('shows the server message at the field when a value is refused, and keeps the form', async () => {
    const user = userEvent.setup()
    mockFetch({ status: 200, body: update }, { status: 400, body: { ok: false, error: '"Done on": Enter a valid date as YYYY-MM-DD', fieldId: 'd' } })
    render(<PublicRequestPage kind="u" token={TOKEN} />)
    await user.type(await screen.findByLabelText('Done on'), '2026-11-20')
    await user.click(screen.getByRole('button', { name: 'Send update' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid date')
    expect(screen.getByLabelText('Done on')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Send update' })).toBeEnabled()
  })

  it.each([
    [404, {}, 'This link is not valid'],
    [410, { state: 'expired' }, 'This link has expired'],
    [410, { state: 'responded' }, 'Already sent'],
    [410, { state: 'revoked' }, 'Request withdrawn'],
    [429, {}, 'Too many attempts'],
    [423, {}, 'This row is locked'],
    [503, {}, 'Not available'],
  ])('closed link: %s %j -> %s', async (status, body, title) => {
    mockFetch({ status, body: { ok: false, error: 'x', ...body } })
    render(<PublicRequestPage kind="u" token={TOKEN} />)
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send update' })).not.toBeInTheDocument()
  })

  it('says so when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('network'))))
    render(<PublicRequestPage kind="u" token={TOKEN} />)
    expect(await screen.findByRole('heading', { name: 'No connection' })).toBeInTheDocument()
  })

  it('a link that was used meanwhile closes the form', async () => {
    const user = userEvent.setup()
    mockFetch({ status: 200, body: update }, { status: 410, body: { ok: false, error: 'used', state: 'responded' } })
    render(<PublicRequestPage kind="u" token={TOKEN} />)
    await user.type(await screen.findByLabelText('Done on'), '2026-11-20')
    await user.click(screen.getByRole('button', { name: 'Send update' }))
    expect(await screen.findByRole('heading', { name: 'Already sent' })).toBeInTheDocument()
  })
})

describe('public approval page', () => {
  const approval = { ok: true, kind: 'approval', sheetName: 'Tower A', message: 'OK to proceed?', expiresAt: '2026-12-01T00:00:00Z', approveLabel: 'Approved', declineLabel: 'Declined', shown: [{ title: 'Hours', value: '8' }] }

  it('shows the chosen values, sends the decision with the comment', async () => {
    const user = userEvent.setup()
    const calls = mockFetch({ status: 200, body: approval }, { status: 200, body: { ok: true } })
    render(<PublicRequestPage kind="a" token={TOKEN} />)
    expect(await screen.findByRole('heading', { name: 'Your approval is needed' })).toBeInTheDocument()
    expect(screen.getByText('OK to proceed?')).toBeInTheDocument()
    expect(screen.getByText('Hours')).toBeInTheDocument()
    expect(screen.getByText(/Approve records “Approved”; decline records “Declined”/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Comment (optional)'), 'Go ahead')
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByText('You approved this request.')).toBeInTheDocument()
    expect(calls[0].url).toBe(`/api/a/${TOKEN}`)
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({ decision: 'approved', comment: 'Go ahead' })
  })

  it('declines', async () => {
    const user = userEvent.setup()
    const calls = mockFetch({ status: 200, body: approval }, { status: 200, body: { ok: true } })
    render(<PublicRequestPage kind="a" token={TOKEN} />)
    await user.click(await screen.findByRole('button', { name: 'Decline' }))
    expect(await screen.findByText('You declined this request.')).toBeInTheDocument()
    expect(JSON.parse(calls[1].init?.body as string)).toMatchObject({ decision: 'declined' })
  })
})
