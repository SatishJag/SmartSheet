import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addUser, createFakeSupabase, emptyState, FAKE_STORAGE_KEY, type StorageLike } from '../../e2e/support/fakeSupabase'
import { SheetList } from '../auth/SheetList'
import { defaultCalendar } from '../engine/calendar'
import { catalogDraft } from '../test/plannerFixtures'
import { planBackward } from './backward'
import { PlannerWizard } from './PlannerWizard'
import type { BatchPlanRequest, PlanDraft, PlannerOptions, PlanRequest } from './types'

const TODAY = '2026-11-16' // a Monday

const OPTIONS: PlannerOptions = {
  scheduleTypes: [{ id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'LLE' }],
  equipmentTypes: { 'lle-procurement': ['Power transformer', 'Switchgear'] },
  projectCounts: { 'lle-procurement': { 'Power transformer': 8, Switchgear: 5 } },
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
  batch?: (request: BatchPlanRequest) => Response | Promise<Response>
}

/** The batch reply a server gives: each item drafted from the catalog, echoing its request. */
function batchReply(request: BatchPlanRequest, failing: number[] = []): Response {
  return json(200, {
    ok: true,
    results: request.items.map((item, i) =>
      failing.includes(i)
        ? { ok: false, error: `Could not draft ${item.equipmentName}` }
        : { ok: true, draft: draftFor({ ...item, scheduleType: request.scheduleType, ...(request.notes ? { notes: request.notes } : {}) }) },
    ),
  })
}

/** Routes fetch('/api/planner/...') to the handlers; records every draft and batch request body. */
function mockServer(server: Server = {}) {
  const drafts: PlanRequest[] = []
  const batches: BatchPlanRequest[] = []
  const headers: Record<string, string>[] = []
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    headers.push(init.headers as Record<string, string>)
    if (url === '/api/planner/options') return (server.options ?? (() => json(200, OPTIONS)))()
    if (url === '/api/planner/draft') {
      const request = JSON.parse(init.body as string) as PlanRequest
      drafts.push(request)
      return (server.draft ?? ((r) => json(200, { ok: true, draft: draftFor(r) })))(request)
    }
    if (url === '/api/planner/draft-batch') {
      const request = JSON.parse(init.body as string) as BatchPlanRequest
      batches.push(request)
      return (server.batch ?? ((r) => batchReply(r)))(request)
    }
    return json(404, { error: 'not found' })
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, drafts, batches, headers }
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

describe('PlannerWizard: project type and schedule type', () => {
  const OPTIONS_BY_PROJECT: PlannerOptions = {
    projectTypes: [
      { id: 'data-centre', name: 'Data centre', description: 'Halls' },
      { id: 'properties', name: 'Properties', description: 'Buildings' },
    ],
    // In the order the server lists them (by position). LLE is offered under both project types.
    scheduleTypes: [
      { id: 'materials-procurement', name: 'Materials procurement', description: 'Bulk materials', projectTypes: ['properties'] },
      { id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'LLE', projectTypes: ['data-centre', 'properties'] },
      { id: 'other-equipment-procurement', name: 'Other equipment procurement', description: 'Other', projectTypes: ['data-centre'] },
      { id: 'consultant-appointment', name: 'Consultant appointment', description: 'Consultants', projectTypes: ['data-centre', 'properties'] },
    ],
    equipmentTypes: { 'lle-procurement': ['Power transformer'], 'materials-procurement': [], 'other-equipment-procurement': [], 'consultant-appointment': [] },
  }
  const names = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => o.textContent)

  it('moves the schedule type to the first one the new project type offers, even when the old one is still on offer', async () => {
    mockServer({ options: () => json(200, OPTIONS_BY_PROJECT) })
    const { user } = setup()
    const project = await screen.findByLabelText('Project type')
    const schedule = screen.getByLabelText('Schedule type')
    expect(project).toHaveDisplayValue('Data centre')
    expect(schedule).toHaveDisplayValue('Long-lead equipment procurement')
    expect(names(schedule)).toEqual(['Long-lead equipment procurement', 'Other equipment procurement', 'Consultant appointment'])

    // LLE is offered under Properties too, but the schedule type still follows the project type.
    await user.selectOptions(project, 'properties')
    expect(schedule).toHaveDisplayValue('Materials procurement')
    expect(names(schedule)).toEqual(['Materials procurement', 'Long-lead equipment procurement', 'Consultant appointment'])
    expect(screen.getByText('Bulk materials')).toBeInTheDocument()

    await user.selectOptions(project, 'data-centre')
    expect(schedule).toHaveDisplayValue('Long-lead equipment procurement')
  })

  it('speaks of what the schedule type plans: material, subcontract package, consultant, equipment', async () => {
    const labelled: PlannerOptions = {
      ...OPTIONS_BY_PROJECT,
      scheduleTypes: OPTIONS_BY_PROJECT.scheduleTypes.map((t) =>
        t.id === 'materials-procurement'
          ? { ...t, itemLabels: { noun: 'material', typeExample: 'Reinforcing steel', nameExample: '16 mm rebar for the level 3 slab' } }
          : t,
      ),
    }
    mockServer({ options: () => json(200, labelled) })
    const { user } = setup()
    const project = await screen.findByLabelText('Project type')
    // Equipment, as before
    expect(screen.getByLabelText('Equipment type')).toBeInTheDocument()
    expect(screen.getByLabelText('Equipment name')).toHaveAttribute('placeholder', 'e.g. 400 MVA transformer for substation B')
    expect(screen.getByText(/Choose the equipment and the date it must be on site/)).toBeInTheDocument()

    await user.selectOptions(project, 'properties') // opens on Materials
    expect(screen.getByLabelText('Material type')).toHaveAttribute('placeholder', 'e.g. Reinforcing steel')
    expect(screen.getByLabelText('Material name')).toHaveAttribute('placeholder', 'e.g. 16 mm rebar for the level 3 slab')
    expect(screen.queryByLabelText('Equipment name')).not.toBeInTheDocument()
    expect(screen.getByText(/Choose the material and the date it must be on site/)).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Material items' })).toBeInTheDocument()

    // The messages use the same words
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the material type')
  })

  it('plans with the schedule type shown after switching', async () => {
    const { drafts } = mockServer({ options: () => json(200, OPTIONS_BY_PROJECT) })
    const { user } = setup()
    await user.selectOptions(await screen.findByLabelText('Project type'), 'properties')
    await user.type(screen.getByLabelText('Equipment type'), 'Rebar') // no history for materials yet: free text
    await fillRequest(user)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByRole('table')
    expect(drafts).toHaveLength(1)
    expect(drafts[0].scheduleType).toBe('materials-procurement')
  })
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

// ---- Several equipment items ----

type User = ReturnType<typeof userEvent.setup>
const itemGroup = (n: number) => screen.getByRole('group', { name: `Item ${n}` })
const card = (name: string) => screen.findByRole('checkbox', { name: new RegExp(`^${name}`) })

/** Ticks the two equipment cards: Item 1 is a Power transformer, Item 2 Switchgear. */
async function tickTwo(user: User) {
  await user.click(await card('Power transformer'))
  await user.click(await card('Switchgear'))
}

async function fillItem(user: User, n: number, name: string, date?: string) {
  const group = within(itemGroup(n))
  await user.type(group.getByLabelText('Equipment name'), name)
  if (date) await user.type(group.getByLabelText('Required on site'), date)
}

/** Two items: a transformer due 2028-03-31 (on time) and switchgear due 2027-03-31 (already late). */
async function requestTwo(user: User, opts: { notes?: string } = {}) {
  await tickTwo(user)
  await fillItem(user, 1, '400 MVA transformer, Substation B', '2028-03-31')
  await fillItem(user, 2, '132 kV GIS', '2027-03-31')
  if (opts.notes) await user.type(screen.getByLabelText('Notes for all items (optional)'), opts.notes)
  await user.click(screen.getByRole('button', { name: 'Generate' }))
}

const panel = (title: RegExp) => {
  const header = screen.getByRole('button', { name: title })
  return within(screen.getByRole('region', { name: header.textContent ?? '' }))
}

describe('PlannerWizard: several items, request step', () => {
  it('ticking equipment types adds an item each (replacing the untouched placeholder); unticking removes it', async () => {
    mockServer()
    const { user } = setup()
    const transformer = await screen.findByRole('checkbox', { name: 'Power transformer · 8 projects' })
    expect(await card('Switchgear')).toHaveAccessibleName('Switchgear · 5 projects')
    expect(screen.queryByRole('group', { name: 'Item 1' })).not.toBeInTheDocument() // one item: the plain form

    await user.click(transformer)
    expect(transformer).toBeChecked()
    expect(screen.getByLabelText('Equipment type')).toHaveValue('Power transformer')

    await user.click(await card('Switchgear'))
    expect(within(itemGroup(1)).getByLabelText('Equipment type')).toHaveValue('Power transformer')
    expect(within(itemGroup(2)).getByLabelText('Equipment type')).toHaveValue('Switchgear')

    await user.click(transformer)
    expect(transformer).not.toBeChecked()
    expect(screen.queryByRole('group', { name: 'Item 1' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Equipment type')).toHaveValue('Switchgear')
  })

  it('"Add another item" adds a custom item and focuses its name; Remove drops one', async () => {
    mockServer()
    const { user } = setup()
    await screen.findByLabelText('Schedule type')
    await user.click(screen.getByRole('button', { name: 'Add another item' }))
    expect(within(itemGroup(2)).getByLabelText('Equipment name')).toHaveFocus()
    await user.selectOptions(within(itemGroup(2)).getByLabelText('Equipment type'), 'Other (type it)')
    await user.type(within(itemGroup(2)).getByLabelText('Other equipment type'), 'Chiller')
    await user.click(screen.getByRole('button', { name: 'Remove item 1' }))
    expect(screen.queryByRole('group', { name: 'Item 1' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Other equipment type')).toHaveValue('Chiller')
    expect(screen.queryByRole('button', { name: /Remove item/ })).not.toBeInTheDocument() // the last item cannot be removed
  })

  it('allows at most 6 items', async () => {
    mockServer()
    const { user } = setup()
    await screen.findByLabelText('Schedule type')
    await user.type(screen.getByLabelText('Equipment name'), 'T1')
    for (let i = 2; i <= 6; i++) {
      await user.click(screen.getByRole('button', { name: 'Add another item' }))
      await user.type(within(itemGroup(i)).getByLabelText('Equipment name'), `T${i}`)
    }
    expect(screen.getAllByRole('group', { name: /^Item \d$/ })).toHaveLength(6)
    expect(screen.getByRole('button', { name: 'Add another item' })).toBeDisabled()
    expect(screen.getByText(/up to 6 items at once/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /^Switchgear/ })).toBeDisabled()
  })

  it('validates every item with inline errors and says which item to fix', async () => {
    const { drafts, batches } = mockServer()
    const { user } = setup()
    await tickTwo(user)
    await fillItem(user, 1, 'T1', '2028-03-31')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Item 2: Enter the equipment name')
    expect(within(itemGroup(2)).getByText('Enter the equipment name')).toBeInTheDocument()
    expect(within(itemGroup(2)).getByText('Enter a date, or fill in the shared date')).toBeInTheDocument()
    expect(within(itemGroup(2)).getByLabelText('Equipment name')).toBeInvalid()
    expect(within(itemGroup(1)).queryByText(/Enter/)).not.toBeInTheDocument()
    // Fixing the problems clears the errors as the user goes.
    await fillItem(user, 2, 'S1')
    expect(screen.getByRole('alert')).toHaveTextContent('Item 2: Enter a date, or fill in the shared date')
    await user.type(screen.getByLabelText('Required on site (all items)'), '2028-05-31')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(drafts).toEqual([])
    expect(batches).toEqual([])
  })

  it('"Use the same date for all": one shared date, an item can override it, or turn it off', async () => {
    const { batches } = mockServer()
    const { user } = setup()
    await tickTwo(user)
    await fillItem(user, 1, 'T1')
    await fillItem(user, 2, 'S1', '2028-09-30') // its own date
    await user.type(screen.getByLabelText('Required on site (all items)'), '2028-03-31')
    expect(within(itemGroup(1)).getByText('Uses the shared date, 2028-03-31.')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Notes for all items (optional)'), 'Vendor in Korea')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText(/2 items · earliest required start/)
    expect(batches).toEqual([
      {
        scheduleType: 'lle-procurement',
        notes: 'Vendor in Korea',
        items: [
          { equipmentType: 'Power transformer', equipmentName: 'T1', requiredDate: '2028-03-31' },
          { equipmentType: 'Switchgear', equipmentName: 'S1', requiredDate: '2028-09-30' },
        ],
      },
    ])
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('checkbox', { name: 'Use the same date for all' }))
    expect(screen.queryByLabelText('Required on site (all items)')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Item 1: Enter the date the equipment must be on site')
  })

  it('the date entered for one item becomes the shared date when a second item appears, and comes back when one is left', async () => {
    mockServer()
    const { user } = setup()
    await fillRequest(user, { date: '2028-03-31' })
    await user.click(screen.getByRole('button', { name: 'Add another item' }))
    expect(screen.getByLabelText('Required on site (all items)')).toHaveValue('2028-03-31')
    expect(within(itemGroup(1)).getByLabelText('Required on site')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Remove item 2' }))
    expect(screen.getByLabelText('Required on site')).toHaveValue('2028-03-31')
  })

  it('one item still uses /draft, not the batch endpoint', async () => {
    const { drafts, batches } = mockServer()
    const { user } = setup()
    await fillRequest(user)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByRole('table', { name: /Activities \(14\)/ })
    expect(drafts).toHaveLength(1)
    expect(batches).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Regenerate all/ })).not.toBeInTheDocument()
  })
})

describe('PlannerWizard: several items, preview and create', () => {
  const expected = (date: string) => planBackward(catalogDraft(date), defaultCalendar, TODAY)

  it('sends ONE batch request, then shows an overall summary and a section per item', async () => {
    const { batches, drafts } = mockServer()
    const { user } = setup()
    await requestTwo(user, { notes: 'Be conservative' })
    expect(await screen.findByText(/2 items · earliest required start/)).toBeInTheDocument()
    expect(batches).toHaveLength(1)
    expect(drafts).toHaveLength(0)
    expect(batches[0].items.map((i) => i.requiredDate)).toEqual(['2028-03-31', '2027-03-31'])

    const late = expected('2027-03-31')
    expect(screen.getByText(`2 items · earliest required start ${late.mustStartBy} · 1 item already late`)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Draft plan: 2 items' })).toHaveFocus()

    // Item 1 is open; item 2 is collapsed until opened.
    const first = screen.getByRole('button', { name: /Power transformer — 400 MVA transformer, Substation B/ })
    const second = screen.getByRole('button', { name: /Switchgear — 132 kV GIS/ })
    expect(first).toHaveAttribute('aria-expanded', 'true')
    expect(second).toHaveAttribute('aria-expanded', 'false')
    expect(first).toHaveTextContent(/On time · start by \d{4}-\d{2}-\d{2}/)
    expect(first).toHaveTextContent('AI draft')
    expect(second).toHaveTextContent(`Late by ${late.feasibility.lateByWorkingDays} working days`)
    expect(screen.getAllByRole('table')).toHaveLength(1)

    await user.click(second)
    expect(second).toHaveAttribute('aria-expanded', 'true')
    const tables = screen.getAllByRole('table', { name: /Activities \(14\)/ })
    expect(tables).toHaveLength(2)
    // Each item has its own banner and dates.
    const lateBanner = panel(/Switchgear/).getByRole('alert')
    expect(lateBanner).toHaveTextContent(`This plan should have started ${late.feasibility.lateByWorkingDays} working days ago`)
    expect(within(tables[1]).getByRole('row', { name: /On site/ })).toHaveTextContent('2027-03-31')
    expect(within(tables[0]).getByRole('row', { name: /On site/ })).toHaveTextContent('2028-03-31')
    expect(panel(/Power transformer/).getByRole('status')).toHaveTextContent(/Work must start by/)
    await user.click(first)
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getAllByRole('table')).toHaveLength(1)
  })

  it('creates ONE sheet with a summary row per item and the activities under it', async () => {
    mockServer()
    const { client, user, onCreated } = setup()
    await requestTwo(user)
    await screen.findByText(/2 items · earliest required start/)
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect((await client.from('sheets').select('id,name')).data).toEqual([{ id: onCreated.mock.calls[0][0], name: 'LLE plan – 2 items' }])
    const rows = (await client.from('rows').select('id,parent_id')).data as { id: string; parent_id: string | null }[]
    expect(rows).toHaveLength(2 + 14 + 14)
    const parents = rows.filter((r) => r.parent_id === null)
    expect(parents).toHaveLength(2)
    for (const p of parents) expect(rows.filter((r) => r.parent_id === p.id)).toHaveLength(14)
    expect((await client.from('dependencies').select('id')).data).toHaveLength(28)
  })

  it('flags SAMPLE data once at the top when any item uses it', async () => {
    mockServer({
      batch: (r) =>
        json(200, {
          ok: true,
          results: r.items.map((item, i) => ({
            ok: true,
            draft: draftFor({ ...item, scheduleType: r.scheduleType }, i === 1 ? { history: { ...catalogDraft().history, sampleOnly: true } } : {}),
          })),
        }),
    })
    const { user } = setup()
    await requestTwo(user)
    await screen.findByText(/2 items · earliest required start/)
    expect(screen.getAllByText(/Based on SAMPLE data, not your company's history/)).toHaveLength(1)
    expect(screen.getByText(/1 item uses it/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Switchgear/ })).toHaveTextContent('Sample data')
  })

  it('an item that failed shows its error with Retry for just that item, and Create waits for it', async () => {
    const { batches, drafts } = mockServer({ batch: (r) => batchReply(r, [1]) })
    const { user, onCreated } = setup()
    await requestTwo(user, { notes: 'Shared' })
    await screen.findByText(/1 item failed/)
    expect(screen.getByText(/2 items · earliest required start \d{4}-\d{2}-\d{2} · no item late · 1 item failed/)).toBeInTheDocument()
    const failedHeader = screen.getByRole('button', { name: /Switchgear/ })
    expect(failedHeader).toHaveAttribute('aria-expanded', 'true') // failures open themselves
    expect(failedHeader).toHaveTextContent('Failed')
    const failed = panel(/Switchgear/)
    expect(failed.getByRole('alert')).toHaveTextContent('Could not draft 132 kV GIS')
    expect(screen.getByRole('button', { name: 'Create schedule' })).toBeDisabled()
    expect(screen.getByText(/Retry or remove the items that failed/)).toBeInTheDocument()

    await user.click(failed.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create schedule' })).toBeEnabled())
    // Only that item was drafted again, through /draft, with the shared notes.
    expect(batches).toHaveLength(1)
    expect(drafts).toEqual([
      { scheduleType: 'lle-procurement', equipmentType: 'Switchgear', equipmentName: '132 kV GIS', requiredDate: '2027-03-31', notes: 'Shared' },
    ])
    expect(screen.getByText(/2 items · earliest required start \d{4}-\d{2}-\d{2} · 1 item already late$/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
  })

  it('a failed item can be removed from the plan; one item left is the single view', async () => {
    mockServer({ batch: (r) => batchReply(r, [0]) })
    const { user, client, onCreated } = setup()
    await requestTwo(user)
    await screen.findByText(/1 item failed/)
    await user.click(panel(/Power transformer/).getByRole('button', { name: 'Remove from plan' }))
    expect(screen.getByRole('heading', { name: 'Draft plan: 132 kV GIS' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Regenerate all/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    // One item: the flat sheet, named after it, no summary row.
    expect((await client.from('sheets').select('name')).data).toEqual([{ name: 'LLE – 132 kV GIS' }])
    expect((await client.from('rows').select('id')).data).toHaveLength(14)
  })

  it('"Regenerate this item" drafts only that item with its own instruction; "Regenerate all" sends the batch again', async () => {
    const { batches, drafts } = mockServer()
    const { user } = setup()
    await requestTwo(user, { notes: 'Shared' })
    await screen.findByText(/2 items · earliest required start/)

    const one = panel(/Power transformer/)
    await user.type(one.getByLabelText('Instructions for a new draft of this item (optional)'), 'Use p80 for fabrication')
    await user.click(one.getByRole('button', { name: 'Regenerate this item' }))
    await waitFor(() => expect(drafts).toHaveLength(1))
    expect(drafts[0]).toMatchObject({ equipmentName: '400 MVA transformer, Substation B', notes: 'Shared\nUse p80 for fabrication' })
    expect(batches).toHaveLength(1)
    await waitFor(() => expect(one.getByLabelText('Instructions for a new draft of this item (optional)')).toHaveValue(''))

    await user.type(screen.getByLabelText('Instructions for a new draft of all items (optional)'), 'Domestic vendors')
    await user.click(screen.getByRole('button', { name: 'Regenerate all' }))
    await waitFor(() => expect(batches).toHaveLength(2))
    expect(batches[1]).toEqual({
      scheduleType: 'lle-procurement',
      notes: 'Shared\nDomestic vendors',
      items: [
        { equipmentType: 'Power transformer', equipmentName: '400 MVA transformer, Substation B', requiredDate: '2028-03-31', notes: 'Use p80 for fabrication' },
        { equipmentType: 'Switchgear', equipmentName: '132 kV GIS', requiredDate: '2027-03-31' },
      ],
    })
    await screen.findByText(/2 items · earliest required start/)
  })

  it('a failed regeneration keeps the good draft and says so', async () => {
    let calls = 0
    mockServer({ draft: (r) => (++calls === 1 ? json(502, { ok: false, error: 'overloaded' }) : json(200, { ok: true, draft: draftFor(r) })) })
    const { user } = setup()
    await requestTwo(user)
    await screen.findByText(/2 items · earliest required start/)
    const one = panel(/Power transformer/)
    await user.click(one.getByRole('button', { name: 'Regenerate this item' }))
    expect(await one.findByText('The planning server failed: overloaded')).toBeInTheDocument()
    expect(one.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create schedule' })).toBeEnabled()
  })

  it('a refused batch (e.g. over the hourly quota) returns to the form with the message and Retry; nothing is lost', async () => {
    let calls = 0
    const { batches } = mockServer({
      batch: (r) => (++calls === 1 ? json(429, { ok: false, error: 'This request needs 2 drafts and you have 1 left of your 10 per hour.' }) : batchReply(r)),
    })
    const { user } = setup()
    await requestTwo(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('needs 2 drafts and you have 1 left')
    expect(within(itemGroup(2)).getByLabelText('Equipment name')).toHaveValue('132 kV GIS')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText(/2 items · earliest required start/)
    expect(batches).toHaveLength(2)
    expect(batches[1]).toEqual(batches[0])
  })

  it('when every item fails the form shows the first error', async () => {
    mockServer({ batch: (r) => batchReply(r, [0, 1]) })
    const { user } = setup()
    await requestTwo(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('None of the 2 items could be drafted: Could not draft 400 MVA transformer, Substation B')
  })

  it('a draft the engine cannot schedule fails only its item', async () => {
    mockServer({
      batch: (r) =>
        json(200, {
          ok: true,
          results: r.items.map((item, i) => ({ ok: true, draft: draftFor({ ...item, scheduleType: r.scheduleType }, i === 1 ? { targetCode: 'NOPE' } : {}) })),
        }),
    })
    const { user } = setup()
    await requestTwo(user)
    await screen.findByText(/1 item failed/)
    expect(panel(/Switchgear/).getByRole('alert')).toHaveTextContent('The draft could not be scheduled')
  })

  it('a save failure keeps the preview and Retry creates the whole sheet; nothing is left behind', async () => {
    mockServer()
    const { client, user, onCreated } = setup()
    await requestTwo(user)
    await screen.findByText(/2 items · earliest required start/)
    const realFrom = client.from.bind(client)
    let failNext = true
    vi.spyOn(client, 'from').mockImplementation((table: string) => {
      if (table === 'dependencies' && failNext) {
        failNext = false
        return { insert: async () => ({ data: null, error: { message: 'disk full' } }) } as never
      }
      return realFrom(table)
    })
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    expect(await screen.findByText('Could not create the schedule: disk full')).toBeInTheDocument()
    expect((await realFrom('sheets').select('id')).data).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect((await realFrom('sheets').select('id')).data).toHaveLength(1)
  })
})

describe('PlannerWizard: cost codes', () => {
  const OPTIONS_CC: PlannerOptions = {
    ...OPTIONS,
    costCodes: [
      { code: 'HVS', description: 'HV SiwtchGear', equipmentType: 'Switchgear' },
      { code: 'TRF', description: 'Transformer', equipmentType: 'Power transformer' },
    ],
  }
  const withCodes = () => mockServer({ options: () => json(200, OPTIONS_CC) })

  it('fills the cost code from the equipment type and follows a type change', async () => {
    withCodes()
    const { user } = setup()
    const code = await screen.findByLabelText('Cost code')
    await waitFor(() => expect(code).toHaveValue('TRF'))
    expect(within(code).getByRole('option', { name: 'TRF — Transformer' })).toBeInTheDocument()
    expect(within(code).getByRole('option', { name: 'None' })).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Equipment type'), 'Switchgear')
    expect(code).toHaveValue('HVS')
  })

  it('keeps a hand-picked cost code when the type changes', async () => {
    withCodes()
    const { user } = setup()
    const code = await screen.findByLabelText('Cost code')
    await waitFor(() => expect(code).toHaveValue('TRF'))
    await user.selectOptions(code, '')
    await user.selectOptions(screen.getByLabelText('Equipment type'), 'Switchgear')
    expect(code).toHaveValue('')
  })

  it('keeps an unedited code in step when the schedule type changes the item’s type', async () => {
    mockServer({
      options: () =>
        json(200, {
          ...OPTIONS_CC,
          scheduleTypes: [...OPTIONS.scheduleTypes, { id: 'switchgear-only', name: 'Switchgear only', description: 'S' }],
          equipmentTypes: { ...OPTIONS.equipmentTypes, 'switchgear-only': ['Switchgear'] },
        }),
    })
    const { user } = setup()
    const code = await screen.findByLabelText('Cost code')
    await waitFor(() => expect(code).toHaveValue('TRF'))
    await user.selectOptions(screen.getByLabelText('Schedule type'), 'switchgear-only')
    await waitFor(() => expect(screen.getByLabelText('Cost code')).toHaveValue('HVS'))
  })

  it('does not send the cost code to the planning server', async () => {
    const { batches } = withCodes()
    const { user } = setup()
    await requestTwo(user)
    await screen.findByText(/2 items · earliest required start/)
    const sent = JSON.stringify(batches)
    expect(sent).not.toMatch(/costCode|TRF|HVS/)
  })

  it('creates the sheet with the cost code column and each item’s code', async () => {
    withCodes()
    const { client, user, onCreated } = setup()
    await tickTwo(user)
    await user.selectOptions(within(itemGroup(2)).getByLabelText('Cost code'), '')
    await fillItem(user, 1, '400 MVA transformer, Substation B', '2028-03-31')
    await fillItem(user, 2, '132 kV GIS', '2028-03-31')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText(/2 items · earliest required start/)
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const columns = (await client.from('columns').select('id,title,type,options')).data as { id: string; title: string; type: string; options: string[] | null }[]
    const column = columns.find((c) => c.title === 'Cost code')!
    expect(column).toMatchObject({ type: 'PICKLIST', options: ['HVS — HV SiwtchGear', 'TRF — Transformer'] })
    const rows = (await client.from('rows').select('parent_id,position,cells')).data as { parent_id: string | null; position: string; cells: Record<string, unknown> }[]
    const parents = rows.filter((r) => r.parent_id === null).sort((a, b) => (a.position < b.position ? -1 : 1))
    expect(parents.map((r) => r.cells[column.id])).toEqual(['TRF — Transformer', undefined])
  })

  it('hides the field and adds no column when the options have no cost codes', async () => {
    mockServer()
    const { client, user, onCreated } = setup()
    await fillRequest(user)
    expect(screen.queryByLabelText('Cost code')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const titles = ((await client.from('columns').select('title')).data as { title: string }[]).map((c) => c.title)
    expect(titles).not.toContain('Cost code')
  })
})

describe('PlannerWizard: Procore project', () => {
  const PROJECTS = [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true }]
  const OPTIONS_P: PlannerOptions = {
    ...OPTIONS,
    projects: PROJECTS,
    costCodes: [
      { code: 'HVS', description: 'HV SiwtchGear', equipmentType: 'Switchgear' },
      { code: 'TRF', description: 'Transformer', equipmentType: 'Power transformer' },
    ],
  }
  const withProjects = (options: PlannerOptions = OPTIONS_P) => mockServer({ options: () => json(200, options) })

  it('offers the projects after the schedule type, starting on None', async () => {
    withProjects()
    setup()
    const project = await screen.findByLabelText('Project')
    expect(project).toHaveValue('')
    expect(within(project).getAllByRole('option').map((o) => o.textContent)).toEqual(['None', 'BKK-03 — Bangkok 3'])
    // Right after the schedule type in reading order.
    const schedule = screen.getByLabelText('Schedule type')
    expect(schedule.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(project.compareDocumentPosition(screen.getByLabelText('Equipment type')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps the chosen project when the schedule type changes', async () => {
    withProjects({
      ...OPTIONS_P,
      scheduleTypes: [...OPTIONS.scheduleTypes, { id: 'switchgear-only', name: 'Switchgear only', description: 'S' }],
      equipmentTypes: { ...OPTIONS.equipmentTypes, 'switchgear-only': ['Switchgear'] },
    })
    const { user } = setup()
    await user.selectOptions(await screen.findByLabelText('Project'), 'BKK-03')
    await user.selectOptions(screen.getByLabelText('Schedule type'), 'switchgear-only')
    expect(screen.getByLabelText('Project')).toHaveValue('BKK-03')
  })

  it('does not send the project to the planning server', async () => {
    const { batches } = withProjects()
    const { user } = setup()
    await user.selectOptions(await screen.findByLabelText('Project'), 'BKK-03')
    await requestTwo(user)
    await screen.findByText(/2 items · earliest required start/)
    expect(JSON.stringify(batches)).not.toMatch(/BKK-03|Bangkok/)
  })

  async function createTwo(pick: string) {
    const { client, user, onCreated } = setup()
    await user.selectOptions(await screen.findByLabelText('Project'), pick)
    await requestTwo(user)
    await screen.findByText(/2 items · earliest required start/)
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const columns = (await client.from('columns').select('id,title,type,options,position')).data as {
      id: string
      title: string
      type: string
      options: string[] | null
      position: number
    }[]
    const ordered = [...columns].sort((a, b) => a.position - b.position)
    const project = ordered.find((c) => c.title === 'Project')!
    const rows = (await client.from('rows').select('parent_id,cells')).data as { parent_id: string | null; cells: Record<string, unknown> }[]
    return { ordered, project, parents: rows.filter((r) => r.parent_id === null) }
  }

  it('creates the sheet with the Procore project on every summary row, just before Cost code', async () => {
    withProjects()
    const { ordered, project, parents } = await createTwo('BKK-03')
    expect(project).toMatchObject({ type: 'PICKLIST', options: ['BKK-03 — Bangkok 3'] })
    const i = ordered.indexOf(project)
    expect(ordered[i + 1].title).toBe('Cost code')
    expect(parents.map((r) => r.cells[project.id])).toEqual(['BKK-03 — Bangkok 3', 'BKK-03 — Bangkok 3'])
  })

  it('requires a project before Generate', async () => {
    const { batches } = withProjects()
    const { user } = setup()
    await requestTwo(user)
    expect(await screen.findByText('Choose the project', { selector: '[role="alert"] *, [role="alert"]' })).toBeInTheDocument()
    expect(batches).toHaveLength(0)
    expect(screen.getByLabelText('Project')).toHaveAttribute('aria-invalid', 'true')
    await user.selectOptions(screen.getByLabelText('Project'), 'BKK-03')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText(/2 items · earliest required start/)
    expect(batches).toHaveLength(1)
  })

  it('hides the field and adds no column when there are no projects', async () => {
    mockServer()
    const { client, user, onCreated } = setup()
    await fillRequest(user)
    expect(screen.queryByLabelText('Project')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const titles = ((await client.from('columns').select('title')).data as { title: string }[]).map((c) => c.title)
    expect(titles).not.toContain('Project')
  })
})

describe('PlannerWizard: Retry after a refused request', () => {
  it('drafts the form as it is now, so each draft keeps the cost code of its own equipment type', async () => {
    let calls = 0
    const { batches } = mockServer({
      options: () =>
        json(200, {
          ...OPTIONS,
          costCodes: [
            { code: 'HVS', description: 'HV SiwtchGear', equipmentType: 'Switchgear' },
            { code: 'TRF', description: 'Transformer', equipmentType: 'Power transformer' },
          ],
        }),
      batch: (r) => (++calls === 1 ? json(429, { ok: false, error: 'You have 0 drafts left of your 10 per hour.' }) : batchReply(r)),
    })
    const { client, user, onCreated } = setup()
    await requestTwo(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('0 drafts left')
    // While the request is refused, item 1 changes from a power transformer to switchgear.
    await user.selectOptions(within(itemGroup(1)).getByLabelText('Equipment type'), 'Switchgear')
    expect(within(itemGroup(1)).getByLabelText('Cost code')).toHaveValue('HVS')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText(/2 items · earliest required start/)
    expect(batches[1].items.map((i) => i.equipmentType)).toEqual(['Switchgear', 'Switchgear'])

    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const columns = (await client.from('columns').select('id,title')).data as { id: string; title: string }[]
    const task = columns.find((c) => c.title === 'Task')!.id
    const code = columns.find((c) => c.title === 'Cost code')!.id
    const rows = (await client.from('rows').select('parent_id,cells')).data as { parent_id: string | null; cells: Record<string, unknown> }[]
    const first = rows.find((r) => r.parent_id === null && String(r.cells[task]).startsWith('Switchgear — 400 MVA transformer'))!
    expect(first.cells[code]).toBe('HVS — HV SiwtchGear')
  })
})

describe('PlannerWizard: delivery site', () => {
  const OPTIONS_S: PlannerOptions = {
    ...OPTIONS,
    costCodes: [
      { code: 'HVS', description: 'HV SiwtchGear', equipmentType: 'Switchgear' },
      { code: 'TRF', description: 'Transformer', equipmentType: 'Power transformer' },
    ],
    projects: [
      { code: 'PRG-DC-01', name: 'Data centre programme', isProgram: true, projectType: 'data-centre', inProcore: true },
      { code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true },
      { code: 'SIN-01', name: 'Singapore 1', isProgram: false, projectType: 'data-centre', inProcore: true },
    ],
  }
  const withSites = (options: PlannerOptions = OPTIONS_S) => mockServer({ options: () => json(200, options) })
  const site = (n: number) => within(itemGroup(n)).getByLabelText('Delivery site')

  it('offers the sites only, starting on None, on the second line after the cost code', async () => {
    withSites()
    setup()
    const field = await screen.findByLabelText('Delivery site')
    expect(field).toHaveValue('')
    expect(within(field).getAllByRole('option').map((o) => o.textContent)).toEqual(['None', 'BKK-03 — Bangkok 3', 'SIN-01 — Singapore 1'])
    const code = screen.getByLabelText('Cost code')
    expect(code.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('defaults every unedited item to the plan’s project when it is a site, and follows it', async () => {
    withSites()
    const { user } = setup()
    await tickTwo(user)
    await user.selectOptions(screen.getByLabelText('Project'), 'BKK-03')
    await waitFor(() => expect(site(1)).toHaveValue('BKK-03'))
    expect(site(2)).toHaveValue('BKK-03')
    await user.selectOptions(screen.getByLabelText('Project'), 'PRG-DC-01')
    await waitFor(() => expect(site(1)).toHaveValue(''))
    expect(site(2)).toHaveValue('')
  })

  it('keeps a site picked by hand when the plan’s project changes', async () => {
    withSites()
    const { user } = setup()
    await tickTwo(user)
    await user.selectOptions(site(1), 'SIN-01')
    await user.selectOptions(screen.getByLabelText('Project'), 'BKK-03')
    await waitFor(() => expect(site(2)).toHaveValue('BKK-03'))
    expect(site(1)).toHaveValue('SIN-01')
  })

  it('gives an item ticked later the default site', async () => {
    withSites()
    const { user } = setup()
    await user.click(await card('Power transformer'))
    await user.selectOptions(screen.getByLabelText('Project'), 'BKK-03')
    await user.click(await card('Switchgear'))
    await waitFor(() => expect(site(2)).toHaveValue('BKK-03'))
  })

  it('does not send the site to the planning server', async () => {
    const { batches } = withSites()
    const { user } = setup()
    await user.selectOptions(await screen.findByLabelText('Project'), 'PRG-DC-01')
    await tickTwo(user)
    await user.selectOptions(site(1), 'BKK-03')
    await user.selectOptions(site(2), 'SIN-01')
    await fillItem(user, 1, '400 MVA transformer, Substation B', '2028-03-31')
    await fillItem(user, 2, '132 kV GIS', '2027-03-31')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText(/2 items · earliest required start/)
    expect(JSON.stringify(batches)).not.toMatch(/BKK-03|SIN-01|Bangkok|Singapore|PRG-DC-01/)
  })

  it('creates the sheet with the site on every row of each item', async () => {
    withSites()
    const { client, user, onCreated } = setup()
    await user.selectOptions(await screen.findByLabelText('Project'), 'PRG-DC-01')
    await tickTwo(user)
    await user.selectOptions(site(1), 'SIN-01')
    await fillItem(user, 1, '400 MVA transformer, Substation B', '2028-03-31')
    await fillItem(user, 2, '132 kV GIS', '2028-03-31')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText(/2 items · earliest required start/)
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const columns = ((await client.from('columns').select('id,title,position')).data as { id: string; title: string; position: number }[]).sort(
      (a, b) => a.position - b.position,
    )
    const i = columns.findIndex((c) => c.title === 'Delivery site')
    expect(columns[i - 1].title).toBe('Cost code')
    const col = columns[i].id
    const task = columns.find((c) => c.title === 'Task')!.id
    const rows = (await client.from('rows').select('id,parent_id,cells')).data as { id: string; parent_id: string | null; cells: Record<string, unknown> }[]
    const first = rows.find((r) => r.parent_id === null && String(r.cells[task]).startsWith('Power transformer'))!
    const second = rows.find((r) => r.parent_id === null && String(r.cells[task]).startsWith('Switchgear'))!
    const itemRows = (parent: (typeof rows)[number]) => [parent, ...rows.filter((r) => r.parent_id === parent.id)]
    expect(itemRows(first).every((r) => r.cells[col] === 'SIN-01 — Singapore 1')).toBe(true)
    expect(itemRows(second).every((r) => r.cells[col] === undefined)).toBe(true)
  })

  it('hides the field and adds no column when only the program project is on offer', async () => {
    withSites({ ...OPTIONS_S, projects: [{ code: 'PRG-DC-01', name: 'Data centre programme', isProgram: true, projectType: 'data-centre', inProcore: true }] })
    setup()
    expect(await screen.findByLabelText('Cost code')).toBeInTheDocument()
    expect(screen.queryByLabelText('Delivery site')).not.toBeInTheDocument()
  })
})

describe('PlannerWizard: projects for both businesses', () => {
  const OPTIONS_BOTH: PlannerOptions = {
    projectTypes: [
      { id: 'data-centre', name: 'Data centre', description: 'Halls' },
      { id: 'properties', name: 'Properties', description: 'Villas and towers' },
    ],
    scheduleTypes: [{ id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'LLE', projectTypes: ['data-centre', 'properties'] }],
    equipmentTypes: { 'lle-procurement': ['Power transformer', 'Switchgear'] },
    costCodes: [
      { code: 'HVS', description: 'HV SiwtchGear', equipmentType: 'Switchgear' },
      { code: 'TRF', description: 'Transformer', equipmentType: 'Power transformer' },
    ],
    projects: [
      { code: 'PRG-DC-01', name: 'Data centre programme', isProgram: true, projectType: 'data-centre', inProcore: true },
      { code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true },
      { code: 'VIL-01', name: 'Sample villa', isProgram: false, projectType: 'properties', inProcore: false },
      { code: 'TWR-01', name: 'Sample tower', isProgram: false, projectType: 'properties', inProcore: false },
    ],
  }
  const withBoth = (options: PlannerOptions = OPTIONS_BOTH) => mockServer({ options: () => json(200, options) })
  const optionTexts = (el: HTMLElement) => within(el).getAllByRole('option').map((o) => o.textContent)

  it('lists only the chosen project type’s projects, under the label Project', async () => {
    withBoth()
    const { user } = setup()
    expect(optionTexts(await screen.findByLabelText('Project'))).toEqual(['None', 'PRG-DC-01 — Data centre programme', 'BKK-03 — Bangkok 3'])
    await user.selectOptions(screen.getByLabelText('Project type'), 'properties')
    expect(optionTexts(screen.getByLabelText('Project'))).toEqual(['None', 'VIL-01 — Sample villa', 'TWR-01 — Sample tower'])
  })

  it('clears a project that does not belong to the new project type, and the sites that followed it', async () => {
    withBoth()
    const { user } = setup()
    await user.selectOptions(await screen.findByLabelText('Project'), 'BKK-03')
    await user.click(await card('Power transformer'))
    await waitFor(() => expect(screen.getByLabelText('Delivery site')).toHaveValue('BKK-03'))
    await user.selectOptions(screen.getByLabelText('Project type'), 'properties')
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue(''))
    expect(screen.queryByLabelText('Delivery site')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Cost code')).not.toBeInTheDocument()
  })

  it('shows no cost code or delivery site for property plans, and the sheet has neither column', async () => {
    withBoth()
    const { client, user, onCreated } = setup()
    await user.selectOptions(await screen.findByLabelText('Project type'), 'properties')
    await user.selectOptions(screen.getByLabelText('Project'), 'VIL-01')
    expect(screen.queryByLabelText('Cost code')).not.toBeInTheDocument()
    await requestTwo(user)
    await screen.findByText(/2 items · earliest required start/)
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const columns = (await client.from('columns').select('id,title')).data as { id: string; title: string }[]
    const titles = columns.map((c) => c.title)
    expect(titles).toContain('Project')
    expect(titles).not.toContain('Cost code')
    expect(titles).not.toContain('Delivery site')
    const project = columns.find((c) => c.title === 'Project')!.id
    const rows = (await client.from('rows').select('parent_id,cells')).data as { parent_id: string | null; cells: Record<string, unknown> }[]
    expect(rows.filter((r) => r.parent_id === null).map((r) => r.cells[project])).toEqual(['VIL-01 — Sample villa', 'VIL-01 — Sample villa'])
  })

  it('does not require a project when the list did not load', async () => {
    const { batches } = withBoth({ ...OPTIONS_BOTH, projects: undefined })
    const { user } = setup()
    await screen.findByLabelText('Project type')
    expect(screen.queryByLabelText('Project')).not.toBeInTheDocument()
    await requestTwo(user)
    await screen.findByText(/2 items · earliest required start/)
    expect(batches).toHaveLength(1)
  })
})
