import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addUser, createFakeSupabase, emptyState, FAKE_STORAGE_KEY, type StorageLike } from '../../e2e/support/fakeSupabase'
import { SheetList } from '../auth/SheetList'
import { defaultCalendar } from '../engine/calendar'
import { catalogDraft } from '../test/plannerFixtures'
import { planBackward } from './backward'
import { dcMasterCatalog } from './catalogs/dcMasterCatalog'
import { buildDcMasterDraft } from './dcMasterDraft'
import { PlannerWizard } from './PlannerWizard'
import type { BatchPlanRequest, ImportActivitiesResult, ImportRequest, PlanDraft, PlannerOptions, PlanRequest } from './types'

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
  importPlan?: (request: ImportRequest) => Response | Promise<Response>
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
  const imports: ImportRequest[] = []
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
    if (url === '/api/planner/import') {
      const request = JSON.parse(init.body as string) as ImportRequest
      imports.push(request)
      return (server.importPlan ?? (() => json(404, { ok: false, error: 'not found' })))(request)
    }
    return json(404, { error: 'not found' })
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, drafts, batches, headers, imports }
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

  it('offers the projects after the schedule type, starting on Choose a project…', async () => {
    withProjects()
    setup()
    const project = await screen.findByLabelText('Project')
    expect(project).toHaveValue('')
    expect(within(project).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a project…', 'BKK-03 — Bangkok 3', '+ New project…'])
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
    expect(optionTexts(await screen.findByLabelText('Project'))).toEqual(['Choose a project…', 'PRG-DC-01 — Data centre programme', 'BKK-03 — Bangkok 3', '+ New project…'])
    await user.selectOptions(screen.getByLabelText('Project type'), 'properties')
    expect(optionTexts(screen.getByLabelText('Project'))).toEqual(['Choose a project…', 'VIL-01 — Sample villa', 'TWR-01 — Sample tower', '+ New project…'])
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

describe('PlannerWizard: import a plan from Excel', () => {
  const OPTIONS_IMPORT: PlannerOptions = {
    projectTypes: [
      { id: 'data-centre', name: 'Data centre', description: 'Halls' },
      { id: 'properties', name: 'Properties', description: 'Villas and towers' },
    ],
    scheduleTypes: [
      { id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'LLE', projectTypes: ['data-centre', 'properties'] },
      { id: 'property-development', name: 'Property development master schedule', description: 'Property', projectTypes: ['properties'] },
    ],
    equipmentTypes: { 'lle-procurement': ['Power transformer', 'Switchgear'], 'property-development': [] },
    costCodes: [{ code: 'TRF', description: 'Transformer', equipmentType: 'Power transformer' }],
    projects: [
      { code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true },
      { code: 'VIL-01', name: 'Sample villa', isProgram: false, projectType: 'properties', inProcore: false },
      { code: 'TWR-01', name: 'Sample tower', isProgram: false, projectType: 'properties', inProcore: false },
    ],
  }
  const FOUND: ImportActivitiesResult = {
    scheduleType: 'property-development',
    targetCode: 'P420',
    durations: [{ code: 'P035', days: 12, basis: 'estimate', reason: 'Similar to a site survey.' }],
    templateLinks: [],
    history: { scheduleType: 'property-development', equipmentType: null, projectCount: 0, sampleOnly: false, stats: [] },
  }
  const fixtureFile = () => new File([readFileSync(resolve(__dirname, 'import/__fixtures__/plan-template.xlsx'))], 'Plan template.xlsx')
  const withImport = (importPlan: Server['importPlan'] = () => json(200, { ok: true, ...FOUND })) =>
    mockServer({ options: () => json(200, OPTIONS_IMPORT), importPlan })

  async function upload(user: ReturnType<typeof userEvent.setup>, file: File = fixtureFile()) {
    await user.upload(await screen.findByLabelText('Import from Excel file'), file)
  }

  it('imports a plan: What we found shows the detected project, handover and counts', async () => {
    withImport()
    const { user } = setup()
    await upload(user)
    expect(await screen.findByRole('heading', { name: 'What we found' })).toBeInTheDocument()
    expect(screen.getByLabelText('Project type')).toHaveValue('properties')
    expect(screen.getByLabelText('Schedule type')).toHaveValue('property-development')
    expect(screen.getByLabelText('Project')).toHaveValue('VIL-01')
    expect(screen.getByLabelText('Planned handover')).toHaveValue('2028-06-30')
    expect(screen.getByText('6 activities: 5 durations from your file, 1 filled in')).toBeInTheDocument()
  })

  it('sends only codes, names, stages and flags to the server', async () => {
    const { imports } = withImport()
    const { user } = setup()
    await upload(user)
    await screen.findByRole('heading', { name: 'What we found' })
    expect(imports).toHaveLength(1)
    expect(imports[0].activities![0]).toEqual({ code: 'P010', name: 'Define development brief and feasibility', phase: '01 Feasibility', hasDuration: true, hasPredecessors: false })
    const sent = JSON.stringify(imports)
    expect(sent).not.toContain('Product mix') // criteria
    expect(sent).not.toContain('Investment / Client') // responsibility
    expect(sent).not.toContain('2027-01-04') // dates
  })

  it('requires the project and handover before Preview', async () => {
    withImport()
    const { user } = setup()
    await upload(user)
    await screen.findByRole('heading', { name: 'What we found' })
    await user.selectOptions(screen.getByLabelText('Project'), '')
    await user.clear(screen.getByLabelText('Planned handover'))
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Choose the project')
    await user.selectOptions(screen.getByLabelText('Project'), 'VIL-01')
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the planned handover date')
  })

  it('changing the schedule type fetches durations again', async () => {
    const { imports } = withImport()
    const { user } = setup()
    await upload(user)
    await screen.findByRole('heading', { name: 'What we found' })
    await user.selectOptions(screen.getByLabelText('Schedule type'), '')
    await waitFor(() => expect(imports).toHaveLength(2))
    expect(imports[1].scheduleType).toBeNull()
  })

  it('the preview of an import has no Regenerate controls, and Back returns to What we found', async () => {
    withImport()
    const { user } = setup()
    await upload(user)
    await screen.findByRole('heading', { name: 'What we found' })
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByRole('button', { name: 'Create schedule' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Regenerate/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Instructions for a new draft/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('heading', { name: 'What we found' })).toBeInTheDocument()
  })

  it('What we found’s Project list adds a new project under the project type shown', async () => {
    withImport()
    const { client, user } = setup()
    await upload(user)
    await screen.findByRole('heading', { name: 'What we found' })
    await user.selectOptions(screen.getByLabelText('Project'), '+ New project…')
    const group = screen.getByRole('group', { name: 'New project' })
    await user.type(within(group).getByLabelText('Code'), 'VIL-09')
    await user.type(within(group).getByLabelText('Name'), 'Lakeside villas{Enter}')
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue('VIL-09'))
    expect(screen.getByRole('heading', { name: 'What we found' })).toBeInTheDocument() // Enter did not submit the step
    const saved = (await client.from('projects').select('code, project_type')).data
    expect(saved).toEqual([{ code: 'VIL-09', project_type: 'properties' }])
  })

  it('Create makes one sheet with the file’s activities, IDs, statuses and Basis notes', async () => {
    withImport()
    const { client, user, onCreated } = setup()
    await upload(user)
    await screen.findByRole('heading', { name: 'What we found' })
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    await user.click(await screen.findByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const columns = (await client.from('columns').select('id,title')).data as { id: string; title: string }[]
    const col = (title: string) => columns.find((c) => c.title === title)!.id
    expect(columns.map((c) => c.title)).not.toContain('Cost code')
    const rows = (await client.from('rows').select('cells')).data as { cells: Record<string, unknown> }[]
    expect(rows).toHaveLength(6)
    const byId = (id: string) => rows.find((r) => r.cells[col('Activity ID')] === id)!.cells
    expect(byId('P010')[col('Task')]).toBe('Define development brief and feasibility')
    expect(byId('P010')[col('Basis')]).toBe('from your file')
    expect(byId('P030')[col('Status')]).toBe('In progress')
    expect(byId('P035')[col('Basis')]).toBe('AI estimate: Similar to a site survey.')
    expect(byId('P010')[col('Project')]).toBe('VIL-01 — Sample villa')
  })

  it('Back from an import puts the form back as it was', async () => {
    const { batches } = withImport()
    const { user } = setup()
    await waitFor(() => expect(screen.getByLabelText('Project type')).toHaveValue('data-centre'))
    expect(screen.getByLabelText('Schedule type')).toHaveValue('lle-procurement')
    await user.selectOptions(screen.getByLabelText('Project'), 'BKK-03')
    await upload(user)
    await screen.findByRole('heading', { name: 'What we found' })
    expect(screen.getByLabelText('Project type')).toHaveValue('properties')
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByLabelText('Project type')).toHaveValue('data-centre')
    expect(screen.getByLabelText('Schedule type')).toHaveValue('lle-procurement')
    expect(screen.getByLabelText('Project')).toHaveValue('BKK-03')
    await requestTwo(user)
    await screen.findByText(/2 items · earliest required start/)
    expect(batches[0].scheduleType).toBe('lle-procurement')
  })

  it('a failed schedule-type correction goes back to the type whose durations are loaded', async () => {
    let calls = 0
    withImport(() => (++calls === 1 ? json(200, { ok: true, ...FOUND }) : json(429, { ok: false, error: 'You have reached the limit of 10 drafts per hour. Try again later.' })))
    const { user } = setup()
    await upload(user)
    await screen.findByRole('heading', { name: 'What we found' })
    await user.selectOptions(screen.getByLabelText('Schedule type'), '')
    expect(await screen.findByRole('alert')).toHaveTextContent('limit of 10 drafts per hour')
    expect(screen.getByLabelText('Schedule type')).toHaveValue('property-development')
  })

  it('shows the columns the AI matched for a layout it did not know', async () => {
    withImport((req) =>
      json(200, req.columns ? { ok: true, mapping: { sheet: 'odd', headingRow: 0, fields: { activityId: 0, name: 1, duration: 2 } } } : { ok: true, ...FOUND, scheduleType: null, targetCode: null, durations: [], history: null }),
    )
    const { user } = setup()
    await upload(user, new File(['Ref,What,Days\nR1,Dig,5\nR2,Fill,3\n'], 'odd.csv', { type: 'text/csv' }))
    await screen.findByRole('heading', { name: 'What we found' })
    expect(screen.getByText('The AI matched the columns on sheet "odd" (headings in row 1): Ref → activity ID, What → activity, Days → duration. Check them before you preview.')).toBeInTheDocument()
  })

  it('changing the project type on What we found does not touch the request form', async () => {
    // Under Properties the first schedule type is property development, which has no equipment.
    mockServer({
      options: () => json(200, { ...OPTIONS_IMPORT, scheduleTypes: [OPTIONS_IMPORT.scheduleTypes[1], OPTIONS_IMPORT.scheduleTypes[0]] }),
      importPlan: (req) => json(200, { ok: true, ...FOUND, ...(req.scheduleType === null ? { scheduleType: null } : {}) }),
    })
    const { user } = setup()
    await user.click(await card('Switchgear'))
    await upload(user)
    await screen.findByRole('heading', { name: 'What we found' })
    await user.selectOptions(screen.getByLabelText('Project type'), 'data-centre')
    await waitFor(() => expect(screen.getByLabelText('Schedule type')).not.toBeDisabled())
    await user.selectOptions(screen.getByLabelText('Project type'), 'properties')
    await waitFor(() => expect(screen.getByLabelText('Schedule type')).not.toBeDisabled())
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await card('Switchgear')).toBeChecked()
  })

  it('a project-type change whose re-fetch fails puts the project type back too', async () => {
    let calls = 0
    withImport(() => (++calls === 1 ? json(200, { ok: true, ...FOUND }) : json(429, { ok: false, error: 'You have reached the limit of 10 drafts per hour. Try again later.' })))
    const { user } = setup()
    await upload(user)
    await screen.findByRole('heading', { name: 'What we found' })
    await user.selectOptions(screen.getByLabelText('Project type'), 'data-centre')
    expect(await screen.findByRole('alert')).toHaveTextContent('limit of 10 drafts per hour')
    expect(screen.getByLabelText('Project type')).toHaveValue('properties')
    expect(screen.getByLabelText('Schedule type')).toHaveValue('property-development')
  })

  it('closing the wizard while it reads a file stops the import', async () => {
    let release: (r: Response) => void = () => {}
    const { imports } = withImport((req) => (req.columns ? new Promise<Response>((r) => (release = r)) : json(200, { ok: true, ...FOUND })))
    const { user, onClose } = setup()
    await upload(user, new File(['Ref,What,Days\nR1,Dig,\n'], 'odd.csv', { type: 'text/csv' }))
    await screen.findByRole('heading', { name: 'Reading your plan' })
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    release(json(200, { ok: true, mapping: { sheet: 'odd', headingRow: 0, fields: { activityId: 0, name: 1, duration: 2 } } }))
    await new Promise((r) => setTimeout(r, 50))
    expect(imports).toHaveLength(1) // the mapping only: no duration request after Cancel
  })

  it('a file with no activity table says so and creates nothing', async () => {
    withImport((req) => json(200, req.columns ? { ok: true, mapping: null } : { ok: true, ...FOUND }))
    const { user } = setup()
    await upload(user, new File(['Alpha,Beta\n1,2\n'], 'notes.csv', { type: 'text/csv' }))
    expect(await screen.findByText('No list of activities found in this file.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'What we found' })).not.toBeInTheDocument()
  })
})

describe('PlannerWizard: All (full project plan)', () => {
  const FULL_OPTIONS: PlannerOptions = {
    projectTypes: [
      { id: 'data-centre', name: 'Data centre', description: 'Halls' },
      { id: 'properties', name: 'Properties', description: 'Buildings' },
    ],
    scheduleTypes: [
      { id: 'dc-master', name: 'Data centre master schedule', description: 'Full DC plan', projectTypes: ['data-centre'], itemLabels: { noun: 'plan', typeExample: '', nameExample: '', heading: 'Which data centre are you planning?', intro: 'Choose the project and its Ready for Service date.', dateLabel: 'RFS date' } },
      { id: 'property-development', name: 'Property development master schedule', description: 'Full property plan', projectTypes: ['properties'], itemLabels: { noun: 'development', typeExample: 'Residential tower', nameExample: 'Marina Heights', dateLabel: 'Planned handover' } },
      { id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'LLE', projectTypes: ['data-centre', 'properties'] },
    ],
    equipmentTypes: { 'lle-procurement': ['Power transformer'], 'dc-master': [], 'property-development': [] },
    projects: [
      { code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true },
      { code: 'VIL-01', name: 'Sample villa', isProgram: false, projectType: 'properties', inProcore: false },
    ],
    costCodes: [{ code: 'CHL', description: 'Chiller', equipmentType: 'Chiller' }],
  }
  const dcDraft = (request: PlanRequest) =>
    buildDcMasterDraft({ request, catalog: dcMasterCatalog(), histories: {} })

  it('lists All first for Data centre and Properties', async () => {
    mockServer({ options: () => json(200, FULL_OPTIONS) })
    const { user } = setup()
    const schedule = await screen.findByLabelText('Schedule type')
    expect(within(schedule).getAllByRole('option')[0]).toHaveTextContent('All (full project plan)')
    expect(schedule).toHaveValue('dc-master')
    await user.selectOptions(screen.getByLabelText('Project type'), 'properties')
    expect(within(schedule).getAllByRole('option')[0]).toHaveTextContent('All (full project plan)')
    expect(schedule).toHaveValue('property-development')
    // Properties' All keeps its development fields and notes.
    expect(screen.getByLabelText('Planned handover')).toBeInTheDocument()
    expect(screen.getByLabelText('Notes (optional)')).toBeInTheDocument()
  })

  it('Data centre All asks only for the project and the RFS date', async () => {
    mockServer({ options: () => json(200, FULL_OPTIONS) })
    setup()
    expect(await screen.findByLabelText('RFS date')).toBeInTheDocument()
    expect(screen.queryByLabelText('Notes (optional)')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add another item' })).not.toBeInTheDocument()
  })

  it('requires the project for Data centre All', async () => {
    const server = mockServer({ options: () => json(200, FULL_OPTIONS) })
    const { user } = setup()
    await user.type(await screen.findByLabelText('RFS date'), '2030-06-28')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Choose the project')
    expect(server.drafts).toHaveLength(0)
  })

  it('sends one Data centre master request and creates the sheet on the 7-day calendar', async () => {
    const server = mockServer({ options: () => json(200, FULL_OPTIONS), draft: (r) => json(200, { ok: true, draft: dcDraft(r) }) })
    const { client, user, onCreated } = setup()
    await user.selectOptions(await screen.findByLabelText('Project'), 'BKK-03')
    await user.type(screen.getByLabelText('RFS date'), '2030-06-28')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByRole('table')
    expect(server.drafts).toEqual([{ scheduleType: 'dc-master', equipmentType: 'Data centre', equipmentName: 'Bangkok 3', requiredDate: '2030-06-28' }])
    expect(screen.getByText('Dates use a 7-day working week; you can change the calendar in the sheet\'s schedule settings.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Regenerate/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const sheet = (await client.from('sheets').select('name,calendar')).data![0] as { name: string; calendar: { workingWeekdays: number[] } }
    expect(sheet.name).toBe('Full plan – Bangkok 3')
    expect(sheet.calendar.workingWeekdays).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(onCreated).toHaveBeenCalledWith(expect.any(String), 'Full plan – Bangkok 3')
    expect((await client.from('rows').select('id')).data).toHaveLength(199)
  })
})

describe('PlannerWizard: All (review fixes)', () => {
  const OPTS: PlannerOptions = {
    projectTypes: [
      { id: 'data-centre', name: 'Data centre', description: 'Halls' },
      { id: 'properties', name: 'Properties', description: 'Buildings' },
    ],
    scheduleTypes: [
      { id: 'dc-master', name: 'Data centre master schedule', description: 'Full DC plan', projectTypes: ['data-centre'], itemLabels: { noun: 'plan', typeExample: 'Data centre', nameExample: 'Bangkok 3', heading: 'Which data centre are you planning?', intro: 'Choose the project and its Ready for Service date.', dateLabel: 'RFS date' } },
      { id: 'property-development', name: 'Property development master schedule', description: 'Property', projectTypes: ['properties'], itemLabels: { noun: 'development', typeExample: 'Residential tower', nameExample: 'Marina Heights', dateLabel: 'Planned handover' } },
      { id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'LLE', projectTypes: ['data-centre', 'properties'] },
    ],
    equipmentTypes: { 'lle-procurement': ['Power transformer', 'Switchgear'], 'dc-master': [], 'property-development': [] },
    costCodes: [{ code: 'TRF', description: 'Transformer', equipmentType: 'Power transformer' }],
    projects: [
      { code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true },
      { code: 'VIL-01', name: 'Sample villa', isProgram: false, projectType: 'properties', inProcore: false },
    ],
  }
  const dcDraft = (request: PlanRequest) => buildDcMasterDraft({ request, catalog: dcMasterCatalog(), histories: {} })

  it('switching from All to long-lead equipment starts on the first equipment type and its cost code', async () => {
    mockServer({ options: () => json(200, OPTS) })
    const { user } = setup()
    const schedule = await screen.findByLabelText('Schedule type')
    expect(schedule).toHaveValue('dc-master')
    await user.selectOptions(schedule, 'lle-procurement')
    expect(screen.getByLabelText('Equipment type')).toHaveValue('Power transformer')
    expect(screen.getByLabelText('Cost code')).toHaveValue('TRF')
  })

  it('says the Data centre master is built from the template, not that the AI failed', async () => {
    mockServer({ options: () => json(200, OPTS), draft: (r) => json(200, { ok: true, draft: dcDraft(r) }) })
    const { user } = setup()
    await user.selectOptions(await screen.findByLabelText('Project'), 'BKK-03')
    await user.type(screen.getByLabelText('RFS date'), '2030-06-28')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByRole('table')
    expect(screen.getByText('Built from the Data centre master template and past projects')).toBeInTheDocument()
    expect(screen.queryByText(/AI unavailable/)).not.toBeInTheDocument()
    expect(screen.queryByText(/durations are defaults/)).not.toBeInTheDocument()
  })

  it('an import after a Data centre All draft is saved on the usual calendar', async () => {
    mockServer({
      options: () => json(200, OPTS),
      draft: (r) => json(200, { ok: true, draft: dcDraft(r) }),
      importPlan: () =>
        json(200, { ok: true, scheduleType: 'property-development', targetCode: 'P420', durations: [{ code: 'P035', days: 12, basis: 'estimate', reason: 'Similar.' }], templateLinks: [], history: { scheduleType: 'property-development', equipmentType: null, projectCount: 0, sampleOnly: false, stats: [] } }),
    })
    const { client, user, onCreated } = setup()
    await user.selectOptions(await screen.findByLabelText('Project'), 'BKK-03')
    await user.type(screen.getByLabelText('RFS date'), '2030-06-28')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Back' }))
    const file = new File([readFileSync(resolve(__dirname, 'import/__fixtures__/plan-template.xlsx'))], 'Plan template.xlsx')
    await user.upload(await screen.findByLabelText('Import from Excel file'), file)
    await screen.findByRole('heading', { name: 'What we found' })
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByText(/Dates use a Monday to Friday working week/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const sheet = (await client.from('sheets').select('calendar')).data![0] as { calendar: { workingWeekdays: number[] } }
    expect(sheet.calendar.workingWeekdays).toEqual(defaultCalendar.workingWeekdays)
  })
})

describe('PlannerWizard: import templates (PR review)', () => {
  it('does not offer the Data centre master as an import template', async () => {
    const options: PlannerOptions = {
      projectTypes: [
        { id: 'data-centre', name: 'Data centre', description: 'Halls' },
        { id: 'properties', name: 'Properties', description: 'Villas and towers' },
      ],
      scheduleTypes: [
        { id: 'dc-master', name: 'Data centre master schedule', description: 'Full DC plan', projectTypes: ['data-centre'] },
        { id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'LLE', projectTypes: ['data-centre', 'properties'] },
        { id: 'property-development', name: 'Property development master schedule', description: 'Property', projectTypes: ['properties'] },
      ],
      equipmentTypes: { 'lle-procurement': ['Power transformer'], 'dc-master': [], 'property-development': [] },
      projects: [{ code: 'VIL-01', name: 'Sample villa', isProgram: false, projectType: 'properties', inProcore: false }],
    }
    mockServer({
      options: () => json(200, options),
      importPlan: () => json(200, { ok: true, scheduleType: null, targetCode: null, durations: [], templateLinks: [], history: null }),
    })
    const { user } = setup()
    await screen.findByLabelText('Schedule type')
    const file = new File([readFileSync(resolve(__dirname, 'import/__fixtures__/plan-template.xlsx'))], 'Plan template.xlsx')
    await user.upload(screen.getByLabelText('Import from Excel file'), file)
    await screen.findByRole('heading', { name: 'What we found' })
    await user.selectOptions(screen.getByLabelText('Project type'), 'data-centre')
    const values = within(screen.getByLabelText('Schedule type')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)
    expect(values).not.toContain('dc-master')
    expect(values).toContain('lle-procurement')
  })
})

describe('PlannerWizard: Data centre All wording', () => {
  const OPTS: PlannerOptions = {
    projectTypes: [{ id: 'data-centre', name: 'Data centre', description: 'Halls' }],
    scheduleTypes: [
      { id: 'dc-master', name: 'Data centre master schedule', description: 'Full DC plan', projectTypes: ['data-centre'], itemLabels: { noun: 'plan', typeExample: 'Data centre', nameExample: 'Bangkok 3', heading: 'Which data centre are you planning?', intro: 'Choose the project and its Ready for Service date.', dateLabel: 'RFS date' } },
    ],
    equipmentTypes: { 'dc-master': [] },
    projects: [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true }],
  }

  it('says days, the RFS date and the template, and shows the intro once', async () => {
    mockServer({ options: () => json(200, OPTS), draft: (r) => json(200, { ok: true, draft: buildDcMasterDraft({ request: r, catalog: dcMasterCatalog(), histories: {} }) }) })
    const { user } = setup()
    await user.selectOptions(await screen.findByLabelText('Project'), 'BKK-03')
    expect(screen.getAllByText('Choose the project and its Ready for Service date.')).toHaveLength(1)
    await user.type(screen.getByLabelText('RFS date'), '2028-01-31')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByRole('table')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/^Late by \d+ days/)
    expect(alert).toHaveTextContent(/the RFS date is at risk/)
    expect(alert).not.toHaveTextContent(/working day|on-site/)
    expect(screen.getByText(/bars show duration in days/)).toBeInTheDocument()
    expect(screen.getByText('Review the plan built from the Data centre master template, then create the schedule.')).toBeInTheDocument()
    expect(screen.queryByText(/Review the AI's first cut/)).not.toBeInTheDocument()
  })
})

describe('PlannerWizard: header for Data centre All', () => {
  const OPTS: PlannerOptions = {
    projectTypes: [{ id: 'data-centre', name: 'Data centre', description: 'Halls' }],
    scheduleTypes: [
      { id: 'dc-master', name: 'Data centre master schedule', description: 'Full DC plan', projectTypes: ['data-centre'], itemLabels: { noun: 'plan', typeExample: 'Data centre', nameExample: 'Bangkok 3', heading: 'Which data centre are you planning?', intro: 'Choose the project and its Ready for Service date.', dateLabel: 'RFS date' } },
      { id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'LLE', projectTypes: ['data-centre'] },
    ],
    equipmentTypes: { 'dc-master': [], 'lle-procurement': ['Power transformer'] },
    projects: [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true }],
  }
  const TEMPLATE_LINE = 'Builds the full plan from the Data centre master template; you review and approve.'
  const AI_LINE = 'An AI master planner drafts the first cut; you review and approve.'

  it('says the plan comes from the template, on the request step and the preview', async () => {
    mockServer({ options: () => json(200, OPTS), draft: (r) => json(200, { ok: true, draft: buildDcMasterDraft({ request: r, catalog: dcMasterCatalog(), histories: {} }) }) })
    const { user } = setup()
    expect(await screen.findByText(TEMPLATE_LINE)).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Plan with AI' })).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Project'), 'BKK-03')
    await user.type(screen.getByLabelText('RFS date'), '2028-01-31')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByRole('table')
    expect(screen.getByText(TEMPLATE_LINE)).toBeInTheDocument()
    expect(screen.queryByText(AI_LINE)).not.toBeInTheDocument()
  })

  it('keeps the AI line for other schedule types', async () => {
    mockServer({ options: () => json(200, OPTS) })
    const { user } = setup()
    await user.selectOptions(await screen.findByLabelText('Schedule type'), 'lle-procurement')
    expect(screen.getByText(AI_LINE)).toBeInTheDocument()
  })
})

describe('PlannerWizard: embedded in Procore', () => {
  const OPTS: PlannerOptions = {
    projectTypes: [
      { id: 'data-centre', name: 'Data centre', description: 'Halls' },
      { id: 'properties', name: 'Properties', description: 'Buildings' },
    ],
    scheduleTypes: [
      { id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'LLE', projectTypes: ['data-centre', 'properties'] },
      { id: 'property-development', name: 'Property development master schedule', description: 'Property', projectTypes: ['properties'] },
    ],
    equipmentTypes: { 'lle-procurement': ['Power transformer'], 'property-development': [] },
    projects: [
      { code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true },
      { code: 'VIL-01', name: 'Sample villa', isProgram: false, projectType: 'properties', inProcore: false },
    ],
  }
  function renderEmbedded(initialProject?: string) {
    const { client, userId } = fakeClient()
    const props = { client, userId, onClose: vi.fn(), onCreated: vi.fn(), today: TODAY, embedded: true }
    const view = render(<PlannerWizard {...props} initialProject={initialProject} />)
    return { ...view, props, user: userEvent.setup() }
  }

  it('renders as the page: no Close button, no backdrop, Escape does nothing', async () => {
    mockServer({ options: () => json(200, OPTS) })
    const { container, props, user } = renderEmbedded()
    await screen.findByLabelText('Schedule type')
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    expect(container.querySelector('.planner-backdrop')).toBeNull()
    expect(screen.getByRole('region', { name: 'Plan with AI' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('applies the initial project and its project type', async () => {
    mockServer({ options: () => json(200, OPTS) })
    renderEmbedded('VIL-01')
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue('VIL-01'))
    expect(screen.getByLabelText('Project type')).toHaveValue('properties')
  })

  it('applies a project that arrives after the options loaded', async () => {
    mockServer({ options: () => json(200, OPTS) })
    const { rerender, props } = renderEmbedded()
    await screen.findByLabelText('Project')
    rerender(<PlannerWizard {...props} initialProject="BKK-03" />)
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue('BKK-03'))
    expect(screen.getByLabelText('Project type')).toHaveValue('data-centre')
  })

  it('keeps a project the planner chose before the match arrived', async () => {
    mockServer({ options: () => json(200, OPTS) })
    const { rerender, props, user } = renderEmbedded()
    await user.selectOptions(await screen.findByLabelText('Project'), 'BKK-03')
    rerender(<PlannerWizard {...props} initialProject="VIL-01" />)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByLabelText('Project')).toHaveValue('BKK-03')
    expect(screen.getByLabelText('Project type')).toHaveValue('data-centre')
  })

  it('ignores an unknown project code', async () => {
    mockServer({ options: () => json(200, OPTS) })
    renderEmbedded('ZZZ-9')
    await screen.findByLabelText('Project')
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByLabelText('Project')).toHaveValue('')
    expect(screen.getByLabelText('Project type')).toHaveValue('data-centre')
  })
})

describe('PlannerWizard: embedded review fixes', () => {
  const OPTS: PlannerOptions = {
    projectTypes: [
      { id: 'data-centre', name: 'Data centre', description: 'Halls' },
      { id: 'properties', name: 'Properties', description: 'Buildings' },
    ],
    scheduleTypes: [
      { id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'LLE', projectTypes: ['data-centre', 'properties'] },
      { id: 'other-equipment-procurement', name: 'Other equipment procurement', description: 'Other', projectTypes: ['data-centre'] },
      { id: 'property-development', name: 'Property development master schedule', description: 'Property', projectTypes: ['properties'] },
    ],
    equipmentTypes: { 'lle-procurement': ['Power transformer'], 'other-equipment-procurement': [], 'property-development': [] },
    projects: [
      { code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true },
      { code: 'VIL-01', name: 'Sample villa', isProgram: false, projectType: 'properties', inProcore: false },
    ],
  }
  function renderEmbedded() {
    const { client, userId } = fakeClient()
    const props = { client, userId, onClose: vi.fn(), onCreated: vi.fn(), today: TODAY, embedded: true }
    const view = render(<PlannerWizard {...props} />)
    return { ...view, props, user: userEvent.setup() }
  }

  it('keeps a schedule type or project type the planner changed before the match arrived', async () => {
    mockServer({ options: () => json(200, OPTS) })
    const { rerender, props, user } = renderEmbedded()
    await user.selectOptions(await screen.findByLabelText('Schedule type'), 'other-equipment-procurement')
    rerender(<PlannerWizard {...props} initialProject="BKK-03" />)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByLabelText('Schedule type')).toHaveValue('other-equipment-procurement')
    expect(screen.getByLabelText('Project')).toHaveValue('BKK-03')

    await user.selectOptions(screen.getByLabelText('Project type'), 'properties')
    rerender(<PlannerWizard {...props} initialProject="BKK-03" />)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByLabelText('Project type')).toHaveValue('properties')
  })

  it('drops a project it chose itself when the page has no project any more', async () => {
    mockServer({ options: () => json(200, OPTS) })
    const { rerender, props } = renderEmbedded()
    rerender(<PlannerWizard {...props} initialProject="BKK-03" />)
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue('BKK-03'))
    rerender(<PlannerWizard {...props} initialProject={undefined} />)
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue(''))
  })
})

describe('PlannerWizard: embedded, project kept after the request (Devin review)', () => {
  const OPTS: PlannerOptions = {
    projectTypes: [{ id: 'data-centre', name: 'Data centre', description: 'Halls' }],
    scheduleTypes: [
      { id: 'dc-master', name: 'Data centre master schedule', description: 'Full DC plan', projectTypes: ['data-centre'], itemLabels: { noun: 'plan', typeExample: 'Data centre', nameExample: 'Bangkok 3', heading: 'Which data centre are you planning?', intro: 'Choose the project and its Ready for Service date.', dateLabel: 'RFS date' } },
    ],
    equipmentTypes: { 'dc-master': [] },
    projects: [{ code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true }],
  }

  it('does not drop the matched project once the plan is in preview', async () => {
    mockServer({ options: () => json(200, OPTS), draft: (r) => json(200, { ok: true, draft: buildDcMasterDraft({ request: r, catalog: dcMasterCatalog(), histories: {} }) }) })
    const { client, userId } = fakeClient()
    const onCreated = vi.fn()
    const props = { client, userId, onClose: vi.fn(), onCreated, today: TODAY, embedded: true }
    const { rerender } = render(<PlannerWizard {...props} initialProject="BKK-03" />)
    const user = userEvent.setup()
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue('BKK-03'))
    await user.type(screen.getByLabelText('RFS date'), '2030-06-28')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByRole('table')
    // Procore moves the panel to a project with no match while the plan is being reviewed.
    rerender(<PlannerWizard {...props} initialProject={undefined} />)
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const columns = (await client.from('columns').select('id,title')).data as { id: string; title: string }[]
    const projectCol = columns.find((c) => c.title === 'Project')!.id
    const rows = (await client.from('rows').select('cells')).data as { cells: Record<string, unknown> }[]
    expect(rows.every((r) => r.cells[projectCol] === 'BKK-03 — Bangkok 3')).toBe(true)
  })
})

describe('PlannerWizard: new project', () => {
  const OPTIONS_NEW: PlannerOptions = {
    projectTypes: [
      { id: 'data-centre', name: 'Data centre', description: 'Halls' },
      { id: 'properties', name: 'Properties', description: 'Villas and towers' },
    ],
    scheduleTypes: [{ id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'LLE', projectTypes: ['data-centre', 'properties'] }],
    equipmentTypes: { 'lle-procurement': ['Power transformer', 'Switchgear'] },
    projects: [
      { code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true },
      { code: 'VIL-01', name: 'Sample villa', isProgram: false, projectType: 'properties', inProcore: false },
      { code: 'VIL-02', name: 'Villa two', isProgram: false, projectType: 'properties', inProcore: false, addedByPlanner: true },
    ],
  }
  const withNew = () => mockServer({ options: () => json(200, OPTIONS_NEW) })
  const optionTexts = (el: HTMLElement) => within(el).getAllByRole('option').map((o) => o.textContent)
  const newProject = () => screen.getByRole('group', { name: 'New project' })
  const saved = async (client: SupabaseClient) =>
    ((await client.from('projects').select('code, name, project_type, created_by, in_procore, is_program, in_planner')).data ?? []) as Record<string, unknown>[]

  async function openNew(user: User) {
    await user.selectOptions(await screen.findByLabelText('Project'), '+ New project…')
    return newProject()
  }

  it('offers + New project… last, and labels planner-added projects not in Procore as new', async () => {
    withNew()
    const { user } = setup()
    expect(optionTexts(await screen.findByLabelText('Project'))).toEqual(['Choose a project…', 'BKK-03 — Bangkok 3', '+ New project…'])
    await user.selectOptions(screen.getByLabelText('Project type'), 'properties')
    expect(optionTexts(screen.getByLabelText('Project'))).toEqual(['Choose a project…', 'VIL-01 — Sample villa', 'VIL-02 — Villa two (new)', '+ New project…'])
  })

  it('shows Code and Name; the code is upper-cased as typed; the project stays as it was', async () => {
    withNew()
    const { user } = setup()
    await user.selectOptions(await screen.findByLabelText('Project'), 'BKK-03')
    const group = await openNew(user)
    expect(screen.getByLabelText('Project')).toHaveValue('BKK-03')
    const code = within(group).getByLabelText('Code')
    expect(within(group).getByText('Capitals, digits and hyphens, up to 20 (e.g. BKK-04)')).toBeInTheDocument()
    await user.type(code, 'bkk-04')
    expect(code).toHaveValue('BKK-04')
  })

  it('checks the fields and saves nothing until they are right', async () => {
    withNew()
    const { client, user } = setup()
    const group = await openNew(user)
    await user.click(within(group).getByRole('button', { name: 'Add project' }))
    expect(within(group).getByText('Enter a code')).toBeInTheDocument()
    expect(within(group).getByText('Enter a name')).toBeInTheDocument()
    await user.type(within(group).getByLabelText('Code'), 'BKK 04')
    await user.type(within(group).getByLabelText('Name'), 'Bangkok, 4')
    await user.click(within(group).getByRole('button', { name: 'Add project' }))
    expect(within(group).getByText('Use capitals, digits and hyphens (up to 20)')).toBeInTheDocument()
    expect(within(group).getByText('A name cannot contain a comma')).toBeInTheDocument()
    expect(await saved(client)).toEqual([])
  })

  it('Add project saves it under the project type on screen, selects it as new and closes the fields', async () => {
    withNew()
    const { client, userId, user } = setup()
    await user.selectOptions(await screen.findByLabelText('Project type'), 'properties')
    const group = await openNew(user)
    await user.type(within(group).getByLabelText('Code'), 'vil-03')
    await user.type(within(group).getByLabelText('Name'), 'Hillside villas')
    await user.click(within(group).getByRole('button', { name: 'Add project' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'New project' })).not.toBeInTheDocument())
    expect(await saved(client)).toEqual([
      { code: 'VIL-03', name: 'Hillside villas', project_type: 'properties', created_by: userId, in_procore: false, is_program: false, in_planner: true },
    ])
    const project = screen.getByLabelText('Project')
    expect(project).toHaveValue('VIL-03')
    expect(within(project).getByRole('option', { selected: true })).toHaveTextContent('VIL-03 — Hillside villas (new)')
  })

  it('says when the code already exists and keeps the fields open', async () => {
    withNew()
    const { client, userId, user } = setup()
    await client.from('projects').insert({ code: 'BKK-04', name: 'Bangkok 4', created_by: userId, in_procore: false, is_program: false, in_planner: true })
    const group = await openNew(user)
    await user.type(within(group).getByLabelText('Code'), 'BKK-04')
    await user.type(within(group).getByLabelText('Name'), 'Bangkok four')
    await user.click(within(group).getByRole('button', { name: 'Add project' }))
    expect(await within(group).findByText('BKK-04 already exists')).toBeInTheDocument()
    expect(screen.getByLabelText('Project')).toHaveValue('')
    expect((await saved(client)).map((p) => p.name)).toEqual(['Bangkok 4'])
  })

  it('saves once when Add project is pressed twice', async () => {
    withNew()
    const { client, user } = setup()
    const insert = vi.spyOn(client, 'from')
    const group = await openNew(user)
    await user.type(within(group).getByLabelText('Code'), 'BKK-05')
    await user.type(within(group).getByLabelText('Name'), 'Bangkok 5')
    const add = within(group).getByRole('button', { name: 'Add project' })
    await user.dblClick(add)
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue('BKK-05'))
    expect(insert.mock.calls.filter(([t]) => t === 'projects')).toHaveLength(1)
  })

  it('Cancel closes the fields without saving', async () => {
    withNew()
    const { client, user } = setup()
    const group = await openNew(user)
    await user.type(within(group).getByLabelText('Code'), 'BKK-06')
    await user.click(within(group).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group', { name: 'New project' })).not.toBeInTheDocument()
    expect(await saved(client)).toEqual([])
  })

  it('the plan created with a new project stores it without "(new)"', async () => {
    withNew()
    const { client, user, onCreated } = setup()
    const group = await openNew(user)
    await user.type(within(group).getByLabelText('Code'), 'BKK-04')
    await user.type(within(group).getByLabelText('Name'), 'Bangkok 4')
    await user.click(within(group).getByRole('button', { name: 'Add project' }))
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue('BKK-04'))
    await requestTwo(user)
    await screen.findByText(/2 items · earliest required start/)
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const columns = (await client.from('columns').select('id,title')).data as { id: string; title: string }[]
    const project = columns.find((c) => c.title === 'Project')!.id
    const rows = (await client.from('rows').select('parent_id,cells')).data as { parent_id: string | null; cells: Record<string, unknown> }[]
    expect(rows.filter((r) => r.parent_id === null).map((r) => r.cells[project])).toEqual(['BKK-04 — Bangkok 4', 'BKK-04 — Bangkok 4'])
  })
})
