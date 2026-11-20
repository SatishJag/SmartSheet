import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { defaultCalendar } from '../engine/calendar'
import type { SchedDep } from '../engine/schedule'
import type { Column } from '../model/validate'
import type { RowRecord, SheetData } from '../store/persistence'
import { SheetStoreProvider } from '../store/SheetStoreContext'
import { createSheetStore } from '../store/sheetStore'
import { AssignPanel, ResourcesButton } from './AssignPanel'
import { createResourceStore } from './resourceStore'
import { ResourceStoreProvider } from './ResourceStoreContext'
import { memory, person, sheetPersistence } from './testkit'

const columns: Column[] = [
  { id: 'name', title: 'Task', type: 'TEXT_NUMBER' },
  { id: 'start', title: 'Start', type: 'DATE', role: 'start' },
  { id: 'dur', title: 'Duration', type: 'DURATION', role: 'duration' },
]
const rec = (id: string, position: string, cells: Record<string, unknown>, parentId: string | null = null): RowRecord => ({ id, parentId, position, cells, version: 0 })
const fs = (predecessorId: string, successorId: string): SchedDep => ({ predecessorId, successorId, type: 'FS', lagMinutes: 0 })

// 2026-11-16 is a Monday.
const data = (over: Partial<SheetData> = {}): SheetData => ({
  sheet: { id: 'sh', name: 'Tower', ownerId: 'u', workspaceId: 'u', calendar: defaultCalendar, dependenciesEnabled: true },
  columns,
  rows: [
    rec('phase', 'a0', { name: 'Phase 1' }),
    rec('t1', 'a1', { name: 'Excavate', start: '2026-11-16', dur: '2d' }, 'phase'),
    rec('t2', 'a2', { name: 'Pour', dur: '3d' }, 'phase'),
    rec('t3', 'a3', { name: 'Cure', start: '2026-11-16', dur: '1d' }),
    rec('m', 'a4', { name: 'Handover', start: '2026-11-20', dur: '0d' }),
  ],
  dependencies: [fs('t1', 't2')],
  ...over,
})

const ada = person('ada', { name: 'Ada Okafor', department: 'Electrical' })
const ben = person('ben', { name: 'Ben Hartley' })
const full = { kind: 'percent', value: 100 } as const

async function mount(opts: { sheet?: SheetData; p?: ReturnType<typeof memory> } = {}) {
  const sheet = createSheetStore(sheetPersistence(opts.sheet ?? data()), { retryDelaysMs: [0, 0, 0] })
  await sheet.getState().load('sh')
  const p = opts.p ?? memory({ resources: [ada, ben] })
  const store = createResourceStore(p)
  const onClose = vi.fn()
  render(
    <SheetStoreProvider store={sheet}>
      <ResourceStoreProvider store={store}>
        <AssignPanel sheetId="sh" onClose={onClose} />
      </ResourceStoreProvider>
    </SheetStoreProvider>,
  )
  await waitFor(() => expect(store.getState().loaded).toBe(true))
  return { sheet, store, p, onClose }
}

const pick = async (user: ReturnType<typeof userEvent.setup>, name: string) => user.click(screen.getByRole('checkbox', { name: new RegExp(`^${name}`) }))
const resourceSelect = () => screen.getByRole('combobox', { name: 'Resource' })

describe('AssignPanel: tasks', () => {
  it('lists the sheet’s tasks with dates (not the summary row) and labels milestones', async () => {
    await mount()
    expect(screen.getByRole('checkbox', { name: /^Excavate/ })).toBeInTheDocument()
    expect(screen.getByText('16 Nov to 17 Nov')).toBeInTheDocument()
    expect(screen.getByText('Milestone 20 Nov')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /^Phase 1/ })).toBeNull()
  })

  it('searches the tasks', async () => {
    const user = userEvent.setup()
    await mount()
    await user.type(screen.getByLabelText('Search tasks'), 'pou')
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    await user.clear(screen.getByLabelText('Search tasks'))
    await user.type(screen.getByLabelText('Search tasks'), 'zzz')
    expect(screen.getByText(/No task matches/)).toBeInTheDocument()
  })

  it('no form until a task is picked', async () => {
    const user = userEvent.setup()
    await mount()
    expect(screen.queryByRole('form', { name: 'Assign a resource' })).toBeNull()
    expect(screen.getByText('Pick tasks, or click one in the sheet')).toBeInTheDocument()
    await pick(user, 'Excavate')
    expect(screen.getByRole('form', { name: 'Assign a resource' })).toBeInTheDocument()
    expect(screen.getByText('1 selected')).toBeInTheDocument()
  })

  it('a click on a grid cell or Gantt bar outside the panel selects that task', async () => {
    await mount()
    const cell = document.createElement('div')
    cell.setAttribute('data-row-id', 't2')
    document.body.appendChild(cell)
    fireEvent.click(cell)
    expect(await screen.findByText('1 selected')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /^Pour/ })).toBeChecked()
    // A summary row is not a task: ignored.
    const summary = document.createElement('div')
    summary.setAttribute('data-row-id', 'phase')
    document.body.appendChild(summary)
    fireEvent.click(summary)
    expect(screen.getByRole('checkbox', { name: /^Pour/ })).toBeChecked()
    cell.remove()
    summary.remove()
  })
})

describe('AssignPanel: assigning', () => {
  it('assigns a resource with a percent allocation, shows the hours, and puts a chip on the task', async () => {
    const user = userEvent.setup()
    const { p, store } = await mount()
    await pick(user, 'Excavate')
    await user.selectOptions(resourceSelect(), screen.getByRole('option', { name: /^Ada Okafor/ }))
    expect(screen.getByText('16 h', { selector: 'strong' })).toBeInTheDocument() // 100% of 2 days
    expect(screen.getByRole('status')).toHaveTextContent('Within capacity.')
    await user.click(screen.getByRole('button', { name: 'Assign to task' }))
    expect(p.saveAssignment).toHaveBeenCalledWith(expect.objectContaining({ sheetId: 'sh', rowId: 't1', resourceId: 'ada', allocation: { kind: 'percent', value: 100 }, startDate: null, endDate: null }))
    expect(await screen.findByText('Ada Okafor is assigned to Excavate.')).toBeInTheDocument()
    expect(store.getState().assignments).toHaveLength(1)
    const assigned = screen.getByRole('region', { name: 'Assigned resources' })
    expect(within(assigned).getByText('Ada Okafor')).toBeInTheDocument()
    expect(within(assigned).getByText('100% · 16 h')).toBeInTheDocument()
    expect(screen.getByLabelText('Assigned: Ada Okafor')).toHaveTextContent('AO')
  })

  it('offers each allocation kind with a sensible default and checks the amount', async () => {
    const user = userEvent.setup()
    await mount()
    await pick(user, 'Excavate')
    await user.selectOptions(resourceSelect(), screen.getByRole('option', { name: /^Ada Okafor/ }))
    const kind = screen.getByRole('combobox', { name: 'Allocation' })
    await user.selectOptions(kind, 'hours_per_day')
    expect(screen.getByLabelText('Hours')).toHaveValue('8')
    await user.selectOptions(kind, 'hours_per_week')
    expect(screen.getByLabelText('Hours')).toHaveValue('40')
    await user.selectOptions(kind, 'total_hours')
    expect(screen.getByLabelText('Hours')).toHaveValue('40')
    await user.clear(screen.getByLabelText('Hours'))
    await user.type(screen.getByLabelText('Hours'), '0')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an amount above 0')
    expect(screen.getByRole('button', { name: 'Assign to task' })).toBeDisabled()
    await user.clear(screen.getByLabelText('Hours'))
    await user.type(screen.getByLabelText('Hours'), '200000')
    expect(screen.getByRole('alert')).toHaveTextContent('At most 100000')
    await user.clear(screen.getByLabelText('Hours'))
    await user.type(screen.getByLabelText('Hours'), '12')
    expect(screen.getByText('12 h', { selector: 'strong' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Assign to task' }))
    expect(await screen.findByText(/is assigned to Excavate/)).toBeInTheDocument()
  })

  it('warns before over-allocating, still lets you assign, and names the days', async () => {
    const user = userEvent.setup()
    const p = memory({
      resources: [ada, ben],
      assignments: [{ id: 'x', sheetId: 'sh', rowId: 't3', resourceId: 'ada', allocation: full, startDate: null, endDate: null }], // Cure: Monday 16 Nov
    })
    const { store } = await mount({ p })
    await pick(user, 'Excavate') // Mon-Tue
    await user.selectOptions(resourceSelect(), screen.getByRole('option', { name: /^Ada Okafor/ }))
    const warning = screen.getByText(/Over-allocated:/).closest('p')!
    expect(warning).toHaveAttribute('role', 'status')
    expect(warning).toHaveTextContent('over capacity on 1 day (Mon 16 Nov)')
    expect(screen.getByRole('list', { name: 'Weekly load with this assignment' })).toHaveTextContent('! 24/40')
    await user.click(screen.getByRole('button', { name: 'Assign to task' }))
    expect(await screen.findByText(/is assigned to Excavate/)).toBeInTheDocument()
    expect(store.getState().assignments).toHaveLength(2)
  })

  it('lists the resource with the most free time first and shows free hours', async () => {
    const user = userEvent.setup()
    const p = memory({ resources: [ada, ben], assignments: [{ id: 'x', sheetId: 'sh', rowId: 't3', resourceId: 'ada', allocation: full, startDate: null, endDate: null }] })
    await mount({ p })
    await pick(user, 'Excavate')
    const options = within(resourceSelect()).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['Choose…', 'Ben Hartley — 16 h free', 'Ada Okafor — 8 h free'])
  })

  it('assigns several tasks at once', async () => {
    const user = userEvent.setup()
    const { p, store } = await mount()
    await pick(user, 'Excavate')
    await pick(user, 'Pour')
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    await user.selectOptions(resourceSelect(), screen.getByRole('option', { name: /^Ben Hartley/ }))
    await user.click(screen.getByRole('button', { name: 'Assign to 2 tasks' }))
    expect(await screen.findByText('Ben Hartley is assigned to 2 tasks.')).toBeInTheDocument()
    expect(p.saveAssignment).toHaveBeenCalledTimes(2)
    expect(store.getState().assignments.map((a) => a.rowId).sort()).toEqual(['t1', 't2'])
  })

  it('an assignment can have dates of its own, with a check on the order', async () => {
    const user = userEvent.setup()
    const { p } = await mount()
    await pick(user, 'Pour') // Wed 18 - Fri 20
    await user.selectOptions(resourceSelect(), screen.getByRole('option', { name: /^Ada Okafor/ }))
    await user.click(screen.getByRole('checkbox', { name: /dates of its own/ }))
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-19' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-18' } })
    expect(screen.getByRole('alert')).toHaveTextContent('The end cannot be before the start')
    expect(screen.getByRole('button', { name: 'Assign to task' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-20' } })
    expect(screen.getByText('16 h', { selector: 'strong' })).toBeInTheDocument() // Thu + Fri
    await user.click(screen.getByRole('button', { name: 'Assign to task' }))
    expect(p.saveAssignment).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-11-19', endDate: '2026-11-20' }))
    expect(await screen.findByText(/own dates 19 Nov to 20 Nov/)).toBeInTheDocument()
  })

  it('a milestone has no work to plan', async () => {
    const user = userEvent.setup()
    await mount()
    await pick(user, 'Handover')
    await user.selectOptions(resourceSelect(), screen.getByRole('option', { name: /^Ada Okafor/ }))
    expect(screen.getByText(/milestones take no time/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Assign to task' })).toBeDisabled()
  })

  it('shows a save error without losing the form', async () => {
    const user = userEvent.setup()
    const p = memory({ resources: [ada] })
    p.saveAssignment = async () => {
      throw new Error('row-level security')
    }
    await mount({ p })
    await pick(user, 'Excavate')
    await user.selectOptions(resourceSelect(), screen.getByRole('option', { name: /^Ada Okafor/ }))
    await user.click(screen.getByRole('button', { name: 'Assign to task' }))
    expect(await screen.findByText('row-level security')).toBeInTheDocument()
    expect(resourceSelect()).toHaveValue('ada')
  })
})

describe('AssignPanel: changing and removing', () => {
  const withAda = () =>
    memory({
      resources: [ada, ben],
      assignments: [{ id: 'a1', sheetId: 'sh', rowId: 't1', resourceId: 'ada', allocation: { kind: 'hours_per_day', value: 4 }, startDate: null, endDate: null }],
    })

  it('shows what is assigned to the picked task and loads it into the form for editing', async () => {
    const user = userEvent.setup()
    const { p } = await mount({ p: withAda() })
    await pick(user, 'Excavate')
    expect(within(screen.getByRole('region', { name: 'Assigned resources' })).getByText('4 h/day · 8 h')).toBeInTheDocument()
    await user.selectOptions(resourceSelect(), screen.getByRole('option', { name: /^Ada Okafor/ }))
    expect(screen.getByRole('combobox', { name: 'Allocation' })).toHaveValue('hours_per_day')
    expect(screen.getByLabelText('Hours')).toHaveValue('4')
    expect(screen.getByText('Change allocation')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Hours'))
    await user.type(screen.getByLabelText('Hours'), '6')
    await user.click(screen.getByRole('button', { name: 'Update assignment' }))
    expect(p.saveAssignment).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', allocation: { kind: 'hours_per_day', value: 6 } }))
  })

  it('removes an assignment', async () => {
    const user = userEvent.setup()
    const { store } = await mount({ p: withAda() })
    await pick(user, 'Excavate')
    await user.click(screen.getByRole('button', { name: 'Remove Ada Okafor from Excavate' }))
    await waitFor(() => expect(store.getState().assignments).toHaveLength(0))
    expect(screen.getByText('Nobody is assigned to this task yet.')).toBeInTheDocument()
  })

  it('assignments follow the task: moving it in the sheet moves the hours the panel reports', async () => {
    const user = userEvent.setup()
    const { sheet, store } = await mount({ p: withAda() })
    await pick(user, 'Excavate')
    await user.selectOptions(resourceSelect(), screen.getByRole('option', { name: /^Ada Okafor/ }))
    const strip = () => screen.getByRole('list', { name: 'Weekly load with this assignment' })
    expect(strip().firstElementChild).toHaveTextContent('16 Nov')
    expect(strip().firstElementChild).toHaveTextContent('8/40')
    sheet.getState().setCell('t1', 'start', '2026-11-30')
    await waitFor(() => expect(store.getState().tasks.sh.find((t) => t.rowId === 't1')!.start).toBe('2026-11-30'))
    expect(strip().firstElementChild).toHaveTextContent('30 Nov')
  })
})

describe('AssignPanel: empty and error states', () => {
  it('without resources it points at the Resources page', async () => {
    const user = userEvent.setup()
    await mount({ p: memory({}) })
    await pick(user, 'Excavate')
    expect(screen.getByText(/You have no resources yet/)).toBeInTheDocument()
  })

  it('a sheet without a Start column explains why there is nothing to assign', async () => {
    await mount({ sheet: data({ columns: columns.filter((c) => c.role !== 'start') }) })
    expect(screen.getByText(/no Start column/)).toBeInTheDocument()
  })

  it('a sheet with no scheduled tasks says so', async () => {
    await mount({ sheet: data({ rows: [], dependencies: [] }) })
    expect(screen.getByText(/Nothing is scheduled yet/)).toBeInTheDocument()
  })

  it('Escape and the close button close the panel', async () => {
    const user = userEvent.setup()
    const { onClose } = await mount()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('ResourcesButton', () => {
  it('reads nothing until opened, then opens and closes the panel', async () => {
    const user = userEvent.setup()
    const sheet = createSheetStore(sheetPersistence(data()), { retryDelaysMs: [0, 0, 0] })
    await sheet.getState().load('sh')
    const from = vi.fn(() => {
      throw new Error('stop')
    })
    const client = { from, rpc: vi.fn() } as unknown as SupabaseClient
    render(
      <SheetStoreProvider store={sheet}>
        <ResourcesButton client={client} sheetId="sh" />
      </SheetStoreProvider>,
    )
    const button = screen.getByRole('button', { name: 'Assign resources' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(from).not.toHaveBeenCalled()
    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByRole('complementary')).toBeInTheDocument()
    expect(from).toHaveBeenCalled() // the panel loads resources now
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })
})
