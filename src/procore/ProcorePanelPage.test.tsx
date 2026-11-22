import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addUser, createFakeSupabase, emptyState, FAKE_STORAGE_KEY, type StorageLike } from '../../e2e/support/fakeSupabase'
import { ProcorePanelPage, storageAvailable } from './ProcorePanelPage'

const wizardProps: Record<string, unknown>[] = []
vi.mock('../planner/PlannerWizard', () => ({
  PlannerWizard: (props: { onCreated: (id: string, name?: string) => void; onClose: () => void; initialProject?: string; embedded?: boolean }) => {
    wizardProps.push(props)
    return (
      <div>
        <p>Wizard {props.embedded ? 'embedded' : 'dialog'} project={props.initialProject ?? ''}</p>
        <button type="button" onClick={() => props.onCreated('s1', 'Full plan – Bangkok 3')}>
          Fake create
        </button>
      </div>
    )
  },
}))

function client(signedIn: boolean) {
  const state = emptyState()
  const user = addUser(state, 'planner@example.com', 'planner-password')
  if (signedIn) state.sessionUserId = user.id
  const map = new Map([[FAKE_STORAGE_KEY, JSON.stringify(state)]])
  const storage: StorageLike = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
  return createFakeSupabase({ storage }) as unknown as SupabaseClient
}

const LOCATION = { search: '?company=42&project=7', origin: 'https://smartsheet.example', href: 'https://smartsheet.example/procore?company=42&project=7' }

function stubFetch(match: unknown = { code: 'BKK-03' }) {
  const fetch = vi.fn(async (url: string) =>
    url.startsWith('/api/procore/project') ? Response.json(match) : Response.json({ error: 'not found' }, { status: 404 }),
  )
  vi.stubGlobal('fetch', fetch)
  return fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
  wizardProps.length = 0
})

describe('ProcorePanelPage', () => {
  it('asks a signed-out planner to sign in, and shows nothing else', async () => {
    stubFetch()
    render(<ProcorePanelPage client={client(false)} location={LOCATION} />)
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByText(/Wizard/)).not.toBeInTheDocument()
  })

  it('shows Plan with AI embedded, on the Procore project it was opened on', async () => {
    const fetch = stubFetch()
    render(<ProcorePanelPage client={client(true)} location={LOCATION} />)
    expect(await screen.findByText('Wizard embedded project=BKK-03')).toBeInTheDocument()
    expect(fetch.mock.calls[0][0]).toBe('/api/procore/project?company=42&project=7')
  })

  it('leaves the project to the planner when there is no match or no context', async () => {
    stubFetch({ code: null, reason: 'not-configured' })
    render(<ProcorePanelPage client={client(true)} location={LOCATION} />)
    expect(await screen.findByText('Wizard embedded project=')).toBeInTheDocument()
  })

  it('offers Open in SmartSheet after Create schedule, and Plan another', async () => {
    stubFetch()
    render(<ProcorePanelPage client={client(true)} location={LOCATION} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Fake create' }))
    expect(screen.getByRole('heading', { name: 'Schedule created' })).toBeInTheDocument()
    const open = screen.getByRole('link', { name: 'Open in SmartSheet' })
    expect(open).toHaveAttribute('href', 'https://smartsheet.example/?sheet=s1')
    expect(open).toHaveAttribute('target', '_blank')
    expect(open).toHaveAttribute('rel', 'noopener')
    await user.click(screen.getByRole('button', { name: 'Plan another' }))
    await waitFor(() => expect(screen.getByText(/Wizard embedded/)).toBeInTheDocument())
  })

  it('offers a new tab when the browser blocks storage in the frame', async () => {
    stubFetch()
    const blocked = {
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError')
      },
      getItem: () => null,
      removeItem: () => {},
    } as unknown as Storage
    expect(storageAvailable(blocked)).toBe(false)
    render(<ProcorePanelPage client={client(true)} location={LOCATION} storage={blocked} />)
    expect(screen.getByText('Your browser blocks sign-in inside Procore.')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'Open Plan with AI in a new tab' })
    expect(link).toHaveAttribute('href', LOCATION.href)
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.queryByText(/Wizard/)).not.toBeInTheDocument()
  })
})

const setup = (companyId: number, projectId: number) =>
  new MessageEvent('message', { origin: 'https://app.procore.com', source: window, data: { type: 'setup', context: { company_id: companyId, project_id: projectId } } })

describe('ProcorePanelPage: review fixes', () => {
  it('puts the plan in a main landmark', async () => {
    stubFetch()
    render(<ProcorePanelPage client={client(true)} location={LOCATION} />)
    const main = await screen.findByRole('main')
    expect(main).toHaveTextContent('Wizard embedded')
  })

  it('names the new sheet and moves focus to "Schedule created"', async () => {
    stubFetch()
    render(<ProcorePanelPage client={client(true)} location={LOCATION} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Fake create' }))
    const heading = screen.getByRole('heading', { name: 'Schedule created' })
    expect(heading).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('Full plan – Bangkok 3 is saved as a sheet in SmartSheet.')
  })

  it('drops the project when a later Procore context has no match', async () => {
    stubFetch()
    const fetch = vi.fn(async (url: string) => Response.json(url.includes('project=8') ? { code: null, reason: 'no-match' } : { code: 'BKK-03' }))
    vi.stubGlobal('fetch', fetch)
    render(<ProcorePanelPage client={client(true)} location={{ ...LOCATION, search: '?view=panel' }} referrer="https://app.procore.com/" />)
    await screen.findByText(/Wizard embedded/)
    window.dispatchEvent(setup(42, 7))
    expect(await screen.findByText('Wizard embedded project=BKK-03')).toBeInTheDocument()
    window.dispatchEvent(setup(42, 8))
    expect(await screen.findByText('Wizard embedded project=')).toBeInTheDocument()
  })

  it('keeps the side panel’s project in the new-tab link when storage is blocked', async () => {
    const blocked = { setItem: () => { throw new DOMException('blocked', 'SecurityError') }, getItem: () => null, removeItem: () => {} } as unknown as Storage
    const location = { search: '?view=panel', origin: 'https://smartsheet.example', href: 'https://smartsheet.example/procore?view=panel' }
    render(<ProcorePanelPage client={client(true)} location={location} storage={blocked} referrer="https://app.procore.com/" />)
    window.dispatchEvent(setup(42, 7))
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Open Plan with AI in a new tab' })).toHaveAttribute('href', 'https://smartsheet.example/procore?view=panel&company=42&project=7'),
    )
  })
})
