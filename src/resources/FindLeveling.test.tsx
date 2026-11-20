import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { ShellProvider } from '../shell/ShellContext'
import { FindResource } from './FindResource'
import { LevelingPanel } from './LevelingPanel'
import { createResourceStore } from './resourceStore'
import { ResourceStoreProvider } from './ResourceStoreContext'
import { memory, person, task } from './testkit'

const full = { kind: 'percent', value: 100 } as const
const MON = '2026-11-16'
const WED = '2026-11-18'

async function mount(ui: React.ReactNode, p: ReturnType<typeof memory>) {
  const store = createResourceStore(p)
  const openSheet = vi.fn()
  render(
    <ShellProvider value={{ client: {} as SupabaseClient, userId: 'u', email: 'u@example.com', openSheet }}>
      <ResourceStoreProvider store={store}>{ui}</ResourceStoreProvider>
    </ShellProvider>,
  )
  await store.getState().loadAll()
  return { store, openSheet }
}

const setDate = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

function findFixture() {
  return memory({
    resources: [
      person('ada', { name: 'Ada Okafor', department: 'Electrical', skills: ['Wiring', 'Testing'] }),
      person('ben', { name: 'Ben Hartley', department: 'Site management' }),
      person('crane', { name: 'Tower crane', kind: 'equipment', department: 'Plant' }),
    ],
    assignments: [{ id: 'a1', sheetId: 's1', rowId: 't1', resourceId: 'ada', allocation: full, startDate: null, endDate: null }],
    sheets: { s1: { name: 'Tower A', tasks: [{ ...task('t1', MON, '2026-11-20'), sheetId: 's1' }] } },
  })
}

describe('FindResource', () => {
  it('lists who fits the dates first, and who does not after', async () => {
    const user = userEvent.setup()
    await mount(<FindResource onShowWorkload={() => undefined} />, findFixture())
    setDate('From', MON)
    setDate('To', '2026-11-20')
    const results = await screen.findByRole('list', { name: 'Results' })
    const rows = within(results).getAllByRole('listitem')
    expect(rows.map((r) => within(r).getByText(/^(Ben Hartley|Tower crane|Ada Okafor)$/).textContent)).toEqual(['Ben Hartley', 'Tower crane', 'Ada Okafor'])
    expect(within(rows[0]).getByText('Fits')).toBeInTheDocument()
    expect(within(rows[2]).getByText('Does not fit')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('2 resources fit 16 Nov to 20 Nov.')
    expect(within(rows[0]).getByText('40 h')).toBeInTheDocument() // free hours
    // A smaller need still does not fit someone fully booked, a total-hours need fits whoever has the hours.
    await user.selectOptions(screen.getByLabelText('I need'), 'total_hours')
    const amount = screen.getByLabelText('Hours')
    await user.clear(amount)
    await user.type(amount, '41')
    expect(screen.getByRole('status')).toHaveTextContent('Nobody fits')
  })

  it('filters by department, type and skills, and explains a bad range', async () => {
    const user = userEvent.setup()
    await mount(<FindResource onShowWorkload={() => undefined} />, findFixture())
    setDate('From', MON)
    setDate('To', '2026-11-20')
    await user.selectOptions(screen.getByLabelText('Department'), 'Plant')
    expect(within(await screen.findByRole('list', { name: 'Results' })).getAllByRole('listitem')).toHaveLength(1)
    await user.selectOptions(screen.getByLabelText('Department'), '')
    await user.selectOptions(screen.getByLabelText('Type'), 'equipment')
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    await user.selectOptions(screen.getByLabelText('Type'), '')
    await user.type(screen.getByLabelText('Skills'), 'testing')
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    await user.type(screen.getByLabelText('Skills'), ', welding')
    expect(screen.getByText('No resource matches')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Skills'))
    setDate('To', '2026-11-01')
    expect(screen.getByRole('alert')).toHaveTextContent(/end date on or after/)
  })

  it('"Show workload" hands the name and start date to the page', async () => {
    const user = userEvent.setup()
    const onShow = vi.fn()
    await mount(<FindResource onShowWorkload={onShow} />, findFixture())
    setDate('From', MON)
    await user.click((await screen.findAllByRole('button', { name: 'Show workload' }))[0])
    expect(onShow).toHaveBeenCalledWith('Ben Hartley', MON)
  })
})

describe('LevelingPanel', () => {
  const floaty = { totalFloat: 5, freeFloat: 5, critical: false }
  function levelFixture(ben = false) {
    return memory({
      resources: [person('ada', { name: 'Ada Okafor' }), person('ben', { name: 'Ben Hartley' })],
      assignments: [
        { id: 'a1', sheetId: 's1', rowId: 't1', resourceId: 'ada', allocation: full, startDate: null, endDate: null },
        { id: 'a2', sheetId: 's1', rowId: 't2', resourceId: 'ada', allocation: full, startDate: null, endDate: null },
        ...(ben ? [{ id: 'a3', sheetId: 's1', rowId: 't3', resourceId: 'ben', allocation: full, startDate: null, endDate: null }] : []),
        ...(ben ? [{ id: 'a4', sheetId: 's1', rowId: 't4', resourceId: 'ben', allocation: full, startDate: null, endDate: null }] : []),
      ],
      sheets: {
        s1: {
          name: 'Tower A',
          tasks: [
            { ...task('t1', MON, WED), name: 'Pour slab', sheetId: 's1' },
            { ...task('t2', MON, WED, floaty), name: 'Fix conduit', sheetId: 's1' },
            { ...task('t3', MON, WED), name: 'Crit A', sheetId: 's1' },
            { ...task('t4', MON, WED), name: 'Crit B', sheetId: 's1' },
          ],
        },
      },
    })
  }

  it('suggests delaying the task with float, says what it clears, and opens its sheet', async () => {
    const user = userEvent.setup()
    const { openSheet } = await mount(<LevelingPanel />, levelFixture())
    setDate('From', MON)
    setDate('To', '2026-12-31')
    await user.click(await screen.findByRole('button', { name: 'Find suggestions' }))
    const list = await screen.findByRole('list', { name: 'Suggestions' })
    const item = within(list).getByRole('listitem')
    expect(item).toHaveTextContent('Delay “Fix conduit” by 3 working days')
    expect(item).toHaveTextContent('Ada Okafor')
    expect(item).toHaveTextContent('clears')
    expect(item).toHaveTextContent('Inside its free float')
    await user.click(within(item).getByRole('button', { name: 'Open sheet' }))
    expect(openSheet).toHaveBeenCalledWith('s1')
  })

  it('lists what cannot be levelled (critical work) separately', async () => {
    const user = userEvent.setup()
    await mount(<LevelingPanel />, levelFixture(true))
    setDate('From', MON)
    setDate('To', '2026-12-31')
    await user.click(await screen.findByRole('button', { name: 'Find suggestions' }))
    expect(await screen.findByText('Still over-allocated')).toBeInTheDocument()
    expect(screen.getByText(/Ben Hartley/, { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/no task that can move/)).toBeInTheDocument()
  })

  it('says so when nobody is over capacity, and when no sheet has float', async () => {
    const user = userEvent.setup()
    const p = memory({
      resources: [person('ada', { name: 'Ada Okafor' })],
      assignments: [{ id: 'a1', sheetId: 's1', rowId: 't1', resourceId: 'ada', allocation: { kind: 'percent', value: 50 }, startDate: null, endDate: null }],
      sheets: { s1: { name: 'Tower A', tasks: [{ ...task('t1', MON, WED, { totalFloat: null, freeFloat: null, critical: false }), sheetId: 's1' }] } },
    })
    await mount(<LevelingPanel />, p)
    expect(await screen.findByText(/no float to level with/)).toBeInTheDocument()
    setDate('From', MON)
    setDate('To', '2026-12-31')
    await user.click(screen.getByRole('button', { name: 'Find suggestions' }))
    expect(await screen.findByText('No over-allocation')).toBeInTheDocument()
  })
})
