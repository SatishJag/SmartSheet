import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createFakeSupabase, type StorageLike } from '../../e2e/support/fakeSupabase'
import { ShellProvider } from '../shell/ShellContext'
import { AutomationPage } from './AutomationPage'
import { NotificationBell } from './NotificationBell'

vi.setConfig({ testTimeout: 30_000 })
const SLOW = { timeout: 5000 }

type Fake = ReturnType<typeof createFakeSupabase>
const memoryStorage = (): StorageLike => {
  const map = new Map<string, string>()
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

let fake: Fake
let service: Fake
let openSheet: Mock<(sheetId: string) => void>
let sheetId: string
let cols: Record<string, string>

async function seed() {
  const storage = memoryStorage()
  fake = createFakeSupabase({ storage })
  service = createFakeSupabase({ storage, serviceRole: true })
  const user = (await fake.auth.signUp({ email: 'me@example.com', password: 'password-1' })).data.user!
  sheetId = ((await fake.from('sheets').insert({ name: 'Tower A' }).select('id').single()).data as { id: string }).id
  await fake.from('sheets').insert({ name: 'Archive' })
  const made = (
    await fake
      .from('columns')
      .insert([
        { sheet_id: sheetId, title: 'Task', type: 'TEXT_NUMBER', position: 0 },
        { sheet_id: sheetId, title: 'Status', type: 'PICKLIST', role: 'status', position: 1, options: ['Not started', 'In progress', 'Done'] },
        { sheet_id: sheetId, title: 'Due', type: 'DATE', position: 2 },
      ])
      .select('id, title')
  ).data as { id: string; title: string }[]
  cols = Object.fromEntries(made.map((c) => [c.title, c.id]))
  await fake.from('rows').insert([
    { sheet_id: sheetId, position: 'a0', cells: { [cols.Task]: 'Pour slab', [cols.Status]: 'Done', [cols.Due]: '2026-12-01' } },
    { sheet_id: sheetId, position: 'a1', cells: { [cols.Task]: 'Fix rebar', [cols.Status]: 'In progress' } },
  ])
  return user.id
}

function renderPage(ui = <AutomationPage />) {
  openSheet = vi.fn<(sheetId: string) => void>()
  localStorage.setItem('automation:sheet', sheetId) // the page remembers the last sheet; the list is alphabetical
  return render(
    <ShellProvider value={{ client: fake as unknown as SupabaseClient, userId: 'u', openSheet }}>
      {ui}
    </ShellProvider>,
  )
}
const rulesOf = async () => (await fake.from('automation_rules').select('name, enabled, trigger, action')).data as { name: string; enabled: boolean; trigger: Record<string, unknown>; action: Record<string, unknown> }[]

beforeEach(async () => {
  await seed()
})

describe('Automation page', () => {
  it('offers starters on an empty sheet and creates a rule from one, shown in plain language', async () => {
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByRole('heading', { name: 'No rules on this sheet yet' }, SLOW)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Notify me when Status becomes Done' }))
    const list = await screen.findByRole('list', { name: 'Rules' }, SLOW)
    expect(within(list).getByRole('heading', { name: 'Tell me when Status becomes Done' })).toBeInTheDocument()
    expect(within(list).getByText('When Status becomes Done: notify me (in the app).')).toBeInTheDocument()
    expect(within(list).getByText('Has not run yet')).toBeInTheDocument()
    expect((await rulesOf())[0]).toMatchObject({ enabled: true, trigger: { type: 'cell_becomes', value: 'Done' } })
  })

  it('switches a rule off and on, and deletes it after confirming', async () => {
    const user = userEvent.setup()
    await fake.from('automation_rules').insert({ sheet_id: sheetId, name: 'Rule A', trigger: { type: 'row_added' }, action: { type: 'lock', locked: true } })
    renderPage()
    const sw = await screen.findByRole('checkbox', { name: 'Rule Rule A is on' }, SLOW)
    expect(sw).toBeChecked()
    await user.click(sw)
    await waitFor(async () => expect((await rulesOf())[0].enabled).toBe(false), SLOW)
    expect(screen.getByRole('checkbox', { name: 'Rule Rule A is on' })).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Delete rule Rule A' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/will stop running/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Delete rule' }))
    await waitFor(async () => expect(await rulesOf()).toHaveLength(0), SLOW)
    expect(await screen.findByRole('heading', { name: 'No rules on this sheet yet' })).toBeInTheDocument()
  })

  it('builds a rule: trigger, a condition, an action; says it in words; refuses an incomplete one', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Build a rule' }, SLOW))
    const form = await screen.findByRole('form', { name: 'New rule' })
    expect(within(form).getByTestId('rule-summary')).toHaveTextContent('When Status becomes Done: notify me (in the app).')

    // saving without a name explains why and keeps the form open
    await user.click(within(form).getByRole('button', { name: 'Save rule' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('Give the rule a name.')

    await user.type(within(form).getByLabelText('Rule name'), 'Done and big')
    await user.selectOptions(within(form).getByLabelText('Becomes'), 'Done')
    await user.click(within(form).getByRole('button', { name: '+ Add a condition' }))
    await user.selectOptions(within(form).getByLabelText('Condition column'), cols.Due)
    await user.selectOptions(within(form).getByLabelText('Condition operator'), 'is_future')
    await user.selectOptions(within(form).getByLabelText('Then'), 'lock')
    expect(within(form).getByTestId('rule-summary')).toHaveTextContent('When Status becomes Done, and Due is in the future: lock the row.')
    await user.click(within(form).getByRole('button', { name: 'Save rule' }))

    expect(await screen.findByRole('list', { name: 'Rules' }, SLOW)).toBeInTheDocument()
    const saved = (await rulesOf())[0]
    expect(saved).toMatchObject({ name: 'Done and big', action: { type: 'lock', locked: true }, trigger: { type: 'cell_becomes', columnId: cols.Status, value: 'Done' } })
  })

  it('shows the plain-language summary changing as the date trigger and the digest are chosen', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Build a rule' }, SLOW))
    const form = await screen.findByRole('form', { name: 'New rule' })
    await user.selectOptions(within(form).getByLabelText('When'), 'date')
    await user.selectOptions(within(form).getByLabelText('Date column'), cols.Due)
    expect(within(form).getByTestId('rule-summary')).toHaveTextContent('When 3 days before the Due date: notify me (in the app).')
    await user.selectOptions(within(form).getByLabelText('How often'), 'daily')
    await user.type(within(form).getByLabelText('E-mail addresses'), 'pm@example.com')
    expect(within(form).getByTestId('rule-summary')).toHaveTextContent('notify me (in the app), pm@example.com in a daily digest')
  })

  it('tries a rule on a row without changing anything', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Build a rule' }, SLOW))
    const form = await screen.findByRole('form', { name: 'New rule' })
    await user.selectOptions(within(form).getByLabelText('Becomes'), 'Done')
    await user.click(within(form).getByRole('button', { name: '+ Add a condition' }))
    await user.selectOptions(within(form).getByLabelText('Condition column'), cols.Due)
    await user.selectOptions(within(form).getByLabelText('Condition operator'), 'is_not_blank')
    await user.click(within(form).getByRole('button', { name: 'Test on a row' }))
    const select = await within(form).findByLabelText('Row to test', {}, SLOW)
    await user.selectOptions(select, await within(form).findByRole('option', { name: 'Pour slab' }))
    const result = within(form).getByTestId('test-result')
    expect(result).toHaveTextContent('Due is not blank')
    expect(result).toHaveTextContent('It would:')
    expect(result).toHaveTextContent('Notify you (in the app): "This rule: Pour slab"')
    await user.selectOptions(select, await within(form).findByRole('option', { name: 'Fix rebar' }))
    expect(within(form).getByTestId('test-result')).toHaveTextContent('The conditions are not met, so nothing would happen.')
    expect(await rulesOf()).toHaveLength(0)
    expect((await fake.from('notifications').select('id')).data).toEqual([])
  })

  it('lists the activity and the sent requests, and withdraws a pending request', async () => {
    const user = userEvent.setup()
    const rowId = ((await fake.from('rows').select('id').eq('sheet_id', sheetId).range(0, 0)).data as { id: string }[])[0].id
    await fake.from('automation_runs').insert([
      { rule_name: 'Rule A', sheet_id: sheetId, source: 'browser', outcome: 'done', detail: { row: 'Pour slab', steps: [{ action: 'notify in the app' }] } },
      { rule_name: 'Rule B', sheet_id: sheetId, source: 'server', outcome: 'error', detail: { row: 'Fix rebar', steps: [{ action: 'update request to a@b.co', error: 'Update requests need the server' }] } },
      { rule_name: 'Rule C', sheet_id: sheetId, source: 'browser', outcome: 'skipped', detail: { reason: 'loop' } },
    ])
    renderPage()
    await user.click(await screen.findByRole('tab', { name: 'Activity' }, SLOW))
    const runs = await screen.findByRole('list', { name: 'Activity' }, SLOW)
    expect(within(runs).getAllByRole('listitem')).toHaveLength(3)
    expect(within(runs).getByText('update request to a@b.co: Update requests need the server')).toBeInTheDocument()
    expect(within(runs).getByText('Not run again for its own change')).toBeInTheDocument()
    expect(within(runs).getByText('Failed')).toBeInTheDocument()

    // sent requests (the server creates them; here the service role seeds one)
    const owner = ((await fake.from('sheets').select('owner_id').eq('id', sheetId).single()).data as { owner_id: string }).owner_id
    await service.from('update_requests').insert({ sheet_id: sheetId, row_id: rowId, owner_id: owner, workspace_id: owner, token_hash: 'a'.repeat(64), recipient_email: 'p@q.co', column_ids: [cols.Task], expires_at: '2099-01-01T00:00:00Z' })
    await user.click(screen.getByRole('tab', { name: 'Sent requests' }))
    const sent = await screen.findByRole('list', { name: 'Sent requests' }, SLOW)
    expect(within(sent).getByText('Waiting')).toBeInTheDocument()
    expect(within(sent).getByText(/p@q\.co/)).toBeInTheDocument()
    await user.click(within(sent).getByRole('button', { name: 'Withdraw' }))
    expect(await within(sent).findByText('Withdrawn', {}, SLOW)).toBeInTheDocument()
    expect(((await service.from('update_requests').select('status')).data as { status: string }[])[0].status).toBe('revoked')
  })
})

describe('Notification centre', () => {
  async function note(over: Record<string, unknown> = {}) {
    await fake.from('notifications').insert({ channel: 'app', title: 'Rule A: Pour slab', body: 'Status: Done', sheet_id: sheetId, delivery_status: 'sent', ...over })
  }

  it('shows the unread count on the bell, lists notifications and marks them read', async () => {
    const user = userEvent.setup()
    await note()
    await note({ title: 'Second one', body: '' })
    await note({ title: 'Already read', read_at: '2026-11-16T10:00:00Z' })
    await fake.from('notifications').insert({ channel: 'email', recipient_email: 'x@y.co', title: 'An outbox row', delivery_status: 'pending' })
    renderPage(<NotificationBell />)
    const bell = await screen.findByRole('button', { name: 'Notifications, 2 unread' }, SLOW)
    expect(within(bell).getByText('2')).toBeInTheDocument()
    await user.click(bell)
    const panel = screen.getByRole('region', { name: 'Notifications' })
    expect(within(panel).getAllByRole('listitem')).toHaveLength(3) // the e-mail outbox row is not shown
    expect(within(panel).queryByText('An outbox row')).not.toBeInTheDocument()
    expect(within(panel).getByText('Rule A: Pour slab')).toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'Mark all read' }))
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeInTheDocument()
    const rows = (await fake.from('notifications').select('read_at, channel').eq('channel', 'app')).data as { read_at: string | null }[]
    expect(rows.every((r) => r.read_at)).toBe(true)
  })

  it('opening a notification marks it read and opens its sheet', async () => {
    const user = userEvent.setup()
    await note()
    renderPage(<NotificationBell />)
    await user.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }, SLOW))
    await user.click(screen.getByRole('button', { name: /Rule A: Pour slab/ }))
    expect(openSheet).toHaveBeenCalledWith(sheetId)
    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument()
    await waitFor(async () => expect(((await fake.from('notifications').select('read_at')).data as { read_at: string | null }[])[0].read_at).not.toBeNull(), SLOW)
  })

  it('closes with Escape, says when it is empty, and stays quiet when the tables are missing', async () => {
    const user = userEvent.setup()
    renderPage(<NotificationBell />)
    await user.click(await screen.findByRole('button', { name: 'Notifications' }))
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument()

    const broken = { from: () => { throw new Error('relation "notifications" does not exist') } } as unknown as SupabaseClient
    render(
      <ShellProvider value={{ client: broken, userId: 'u', openSheet: vi.fn() }}>
        <NotificationBell />
      </ShellProvider>,
    )
    expect(await screen.findAllByRole('button', { name: 'Notifications' })).toHaveLength(2)
  })
})
