import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addUser, createFakeSupabase, emptyState, FAKE_STORAGE_KEY, type StorageLike } from '../../e2e/support/fakeSupabase'
import { SheetList } from '../auth/SheetList'
import { catalogDraft } from '../test/plannerFixtures'
import { PlannerWizard } from './PlannerWizard'
import type { PlanDraft, PlannerOptions, PlanRequest } from './types'

const TODAY = '2026-11-16' // a Monday

const OPTIONS: PlannerOptions = {
  scheduleTypes: [{ id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'LLE' }],
  equipmentTypes: { 'lle-procurement': ['Power transformer', 'Switchgear'] },
}

function fakeClient() {
  const state = emptyState()
  const user = addUser(state, 'planner@example.com', 'planner-password')
  state.sessionUserId = user.id
  const map = new Map([[FAKE_STORAGE_KEY, JSON.stringify(state)]])
  const storage: StorageLike = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
  return { client: createFakeSupabase({ storage }) as unknown as SupabaseClient, userId: user.id }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

interface Server {
  options?: () => Response | Promise<Response>
  draft?: (request: PlanRequest) => Response | Promise<Response>
}

/** Routes fetch('/api/planner/...') to the handlers; records every draft request body. */
function mockServer(server: Server = {}) {
  const drafts: PlanRequest[] = []
  const headers: Record<string, string>[] = []
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    headers.push(init.headers as Record<string, string>)
    if (url === '/api/planner/options') return (server.options ?? (() => json(200, OPTIONS)))()
    if (url === '/api/planner/draft') {
      const request = JSON.parse(init.body as string) as PlanRequest
      drafts.push(request)
      return (server.draft ?? ((r) => json(200, { ok: true, draft: draftFor(r) })))(request)
    }
    return json(404, { error: 'not found' })
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, drafts, headers }
}

/** The catalog draft echoing the request (as the server does). */
function draftFor(request: PlanRequest, overrides: Partial<PlanDraft> = {}): PlanDraft {
  const d = catalogDraft(request.requiredDate, { overrides })
  return { ...d, request }
}

function setup(props: { today?: string } = {}) {
  const { client, userId } = fakeClient()
  const onClose = vi.fn()
  const onCreated = vi.fn()
  render(<PlannerWizard client={client} userId={userId} onClose={onClose} onCreated={onCreated} today={props.today ?? TODAY} />)
  return { client, userId, onClose, onCreated, user: userEvent.setup() }
}

async function fillRequest(user: ReturnType<typeof userEvent.setup>, opts: { date?: string; notes?: string } = {}) {
  await user.type(await screen.findByLabelText('Equipment name'), '400 MVA transformer')
  await user.type(screen.getByLabelText('Required on site'), opts.date ?? '2028-03-31')
  if (opts.notes) await user.type(screen.getByLabelText('Notes (optional)'), opts.notes)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PlannerWizard: request step', () => {
  it('is a labelled modal that loads the options and focuses inside', async () => {
    mockServer()
    setup()
    const dialog = screen.getByRole('dialog', { name: 'Plan with AI' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(await screen.findByLabelText('Schedule type')).toHaveDisplayValue('Long-lead equipment procurement')
    const equipment = screen.getByLabelText('Equipment type')
    expect(within(equipment).getAllByRole('option').map((o) => o.textContent)).toEqual(['Power transformer', 'Switchgear', 'Other (type it)'])
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('sends the Supabase access token', async () => {
    const { headers } = mockServer()
    setup()
    await screen.findByLabelText('Schedule type')
    expect(headers[0].Authorization).toMatch(/^Bearer fake-access-token-/)
  })

  it('Escape and Cancel close the wizard', async () => {
    mockServer()
    const { onClose, user } = setup()
    await screen.findByLabelText('Schedule type')
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('validates the fields before asking the server', async () => {
    const { drafts } = mockServer()
    const { user } = setup()
    await screen.findByLabelText('Schedule type')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the equipment name')
    await user.type(screen.getByLabelText('Equipment name'), 'T1')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the date the equipment must be on site')
    expect(drafts).toEqual([])
  })

  it('"Other" and a type without history take free text', async () => {
    const { drafts } = mockServer({ options: () => json(200, { ...OPTIONS, equipmentTypes: {} }) })
    const { user } = setup()
    await user.type(await screen.findByLabelText('Equipment type'), 'Gas turbine')
    await fillRequest(user)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByRole('table')
    expect(drafts[0].equipmentType).toBe('Gas turbine')
  })

  it('an options failure shows the error with Retry', async () => {
    let calls = 0
    mockServer({ options: () => (++calls === 1 ? json(503, { error: 'warming up' }) : json(200, OPTIONS)) })
    const { user } = setup()
    expect(await screen.findByRole('alert')).toHaveTextContent('The planning server failed: warming up')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByLabelText('Schedule type')).toBeInTheDocument()
  })

  it('a 401 says the session expired', async () => {
    mockServer({ options: () => json(401, { error: 'jwt expired' }) })
    setup()
    expect(await screen.findByRole('alert')).toHaveTextContent('Your session has expired')
  })
})

describe('PlannerWizard: drafting and preview', () => {
  it('sends the request, shows a loading state, then the preview with dates and feasibility', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { drafts } = mockServer({
      draft: async (r) => {
        await gate
        return json(200, { ok: true, draft: draftFor(r) })
      },
    })
    const { user } = setup()
    await fillRequest(user, { notes: 'Vendor in Korea' })
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(await screen.findByText('Drafting from historical projects…')).toBeInTheDocument()
    release()

    const table = await screen.findByRole('table', { name: /Activities \(14\)/ })
    expect(drafts[0]).toEqual({
      scheduleType: 'lle-procurement',
      equipmentType: 'Power transformer',
      equipmentName: '400 MVA transformer',
      requiredDate: '2028-03-31',
      notes: 'Vendor in Korea',
    })
    expect(screen.getByRole('heading', { name: 'Draft plan: 400 MVA transformer' })).toHaveFocus()
    expect(screen.getByText('Drafted by AI from 9 historical projects')).toBeInTheDocument()
    const onsite = within(table).getByRole('row', { name: /On site/ })
    expect(onsite).toHaveTextContent('Milestone')
    expect(onsite).toHaveTextContent('2028-03-31')
    expect(onsite).toHaveTextContent('Critical')
    const mfg = within(table).getByRole('row', { name: /^Manufacturing Manufacturing/ })
    expect(mfg).toHaveTextContent('120d')
    expect(mfg).toHaveTextContent('Adjusted')
    expect(mfg).toHaveTextContent('raised 10 days')
    expect(screen.getByRole('status')).toHaveTextContent(/Work must start by \d{4}-\d{2}-\d{2}: \d+ working days from now/)
    expect(screen.getByText('Manufacturing slots are scarce this year.')).toBeInTheDocument()
    expect(screen.getByText('Two qualified vendors respond.')).toBeInTheDocument()
    expect(screen.queryByText(/SAMPLE data/)).not.toBeInTheDocument()
  })

  it('a late plan shows the at-risk banner; sample data and the history fallback are flagged', async () => {
    mockServer({ draft: (r) => json(200, { ok: true, draft: draftFor(r, { source: 'history', history: { ...catalogDraft().history, sampleOnly: true } }) }) })
    const { user } = setup()
    await fillRequest(user, { date: '2027-03-31' })
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/This plan should have started \d+ working days ago; the on-site date is at risk/)
    expect(screen.getByText(/Based on SAMPLE data, not your company's history/)).toBeInTheDocument()
    expect(screen.getByText('Built from history only — AI unavailable (9 historical projects)')).toBeInTheDocument()
  })

  it('no history: says durations are defaults', async () => {
    mockServer({ draft: (r) => json(200, { ok: true, draft: draftFor(r, { history: { ...catalogDraft().history, projectCount: 0, stats: [] } }) }) })
    const { user } = setup()
    await fillRequest(user)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(await screen.findByText('No history for this equipment; durations are defaults.')).toBeInTheDocument()
    expect(screen.getByText('Drafted by AI (no historical projects)')).toBeInTheDocument()
  })

  it('a non-working required date is explained', async () => {
    mockServer()
    const { user } = setup()
    await fillRequest(user, { date: '2027-10-02' }) // a Saturday
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(await screen.findByText(/2027-10-02 is not a working day/)).toBeInTheDocument()
  })

  it('a draft error shows the message and Retry sends the same request', async () => {
    let calls = 0
    const { drafts } = mockServer({
      draft: (r) => (++calls === 1 ? json(422, { ok: false, error: 'Unknown equipment type' }) : json(200, { ok: true, draft: draftFor(r) })),
    })
    const { user } = setup()
    await fillRequest(user)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Unknown equipment type')
    expect(screen.getByLabelText('Equipment name')).toHaveValue('400 MVA transformer')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('table')
    expect(drafts).toHaveLength(2)
    expect(drafts[1]).toEqual(drafts[0])
  })

  it('a draft the engine cannot schedule is an error, not a preview', async () => {
    mockServer({ draft: (r) => json(200, { ok: true, draft: draftFor(r, { targetCode: 'NOPE' }) }) })
    const { user } = setup()
    await fillRequest(user)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The draft could not be scheduled')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('Regenerate appends the instruction to the notes; Back keeps the form', async () => {
    const { drafts } = mockServer()
    const { user } = setup()
    await fillRequest(user, { notes: 'Be conservative' })
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByRole('table')
    await user.type(screen.getByLabelText('Instructions for a new draft (optional)'), 'Use p80 for shipping')
    await user.click(screen.getByRole('button', { name: 'Regenerate' }))
    await waitFor(() => expect(drafts).toHaveLength(2))
    expect(drafts[1].notes).toBe('Be conservative\nUse p80 for shipping')
    await screen.findByRole('table')
    expect(screen.getByLabelText('Instructions for a new draft (optional)')).toHaveValue('')
    // A second regeneration keeps both instructions.
    await user.type(screen.getByLabelText('Instructions for a new draft (optional)'), 'Domestic vendor')
    await user.click(screen.getByRole('button', { name: 'Regenerate' }))
    await waitFor(() => expect(drafts).toHaveLength(3))
    expect(drafts[2].notes).toBe('Be conservative\nUse p80 for shipping\nDomestic vendor')
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText('Equipment name')).toHaveValue('400 MVA transformer')
    expect(screen.getByLabelText('Notes (optional)')).toHaveValue('Be conservative')
  })
})

describe('PlannerWizard: create schedule', () => {
  it('saves the sheet and hands its id to onCreated', async () => {
    mockServer()
    const { client, user, onCreated } = setup()
    await fillRequest(user)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const { data } = await client.from('sheets').select('id,name')
    expect(data).toEqual([{ id: onCreated.mock.calls[0][0], name: 'LLE – 400 MVA transformer' }])
    expect((await client.from('rows').select('id')).data).toHaveLength(14)
    expect((await client.from('dependencies').select('id')).data).toHaveLength(14)
  })

  it('a save failure keeps the preview and offers Retry', async () => {
    mockServer()
    const { client, user, onCreated } = setup()
    await fillRequest(user)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByRole('table')
    const realFrom = client.from.bind(client)
    let failNext = true
    vi.spyOn(client, 'from').mockImplementation((table: string) => {
      if (table === 'rows' && failNext) {
        failNext = false
        return { insert: async () => ({ data: null, error: { message: 'disk full' } }) } as never
      }
      return realFrom(table)
    })
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    expect(await screen.findByText('Could not create the schedule: disk full')).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect((await realFrom('sheets').select('id')).data).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
  })
})

describe('SheetList: Plan with AI', () => {
  it('opens the wizard; the created sheet opens through onOpen', async () => {
    mockServer()
    const { client, userId } = fakeClient()
    const onOpen = vi.fn()
    const user = userEvent.setup()
    render(<SheetList client={client} userId={userId} onOpen={onOpen} />)
    await user.click(screen.getByRole('button', { name: 'Plan with AI' }))
    expect(screen.getByRole('dialog', { name: 'Plan with AI' })).toBeInTheDocument()
    await fillRequest(user, { date: '2030-01-31' })
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closing the wizard returns focus to the button', async () => {
    mockServer()
    const { client, userId } = fakeClient()
    const user = userEvent.setup()
    render(<SheetList client={client} userId={userId} onOpen={() => {}} />)
    const button = screen.getByRole('button', { name: 'Plan with AI' })
    await user.click(button)
    await screen.findByLabelText('Schedule type')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(button).toHaveFocus()
  })
})
