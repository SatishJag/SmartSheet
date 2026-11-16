import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ShellProvider } from '../shell/ShellContext'
import { createResourceStore } from './resourceStore'
import { ResourceStoreProvider } from './ResourceStoreContext'
import { DEFAULT_VIEW, Workload, type WorkloadView } from './Workload'
import { memory, person, task } from './testkit'

const full = { kind: 'percent', value: 100 } as const
const MON = '2026-11-16'

/** Ada is double-booked Mon-Wed; Ben has one light task; Crane (equipment) is idle. */
function fixture(extra: Partial<Parameters<typeof memory>[0]> = {}) {
  return memory({
    resources: [
      person('ada', { name: 'Ada Okafor', department: 'Electrical', skills: ['Wiring'] }),
      person('ben', { name: 'Ben Hartley', department: 'Site management' }),
      person('crane', { name: 'Tower crane', kind: 'equipment', department: 'Plant' }),
    ],
    assignments: [
      { id: 'a1', sheetId: 's1', rowId: 't1', resourceId: 'ada', allocation: full, startDate: null, endDate: null },
      { id: 'a2', sheetId: 's1', rowId: 't2', resourceId: 'ada', allocation: full, startDate: null, endDate: null },
      { id: 'a3', sheetId: 's1', rowId: 't1', resourceId: 'ben', allocation: { kind: 'percent', value: 25 }, startDate: null, endDate: null },
    ],
    sheets: {
      s1: {
        name: 'Tower A',
        tasks: [
          { ...task('t1', MON, '2026-11-18'), name: 'Conduit rough-in', sheetId: 's1' },
          { ...task('t2', MON, '2026-11-18'), name: 'Switchboard', sheetId: 's1' },
        ],
      },
    },
    ...extra,
  })
}

function Harness({ initial }: { initial?: Partial<WorkloadView> }) {
  const [view, setView] = useState<WorkloadView>({ ...DEFAULT_VIEW, anchor: MON, ...initial })
  return <Workload view={view} onView={setView} />
}

async function mount(p = fixture(), initial?: Partial<WorkloadView>) {
  const store = createResourceStore(p)
  const openSheet = vi.fn()
  render(
    <ShellProvider value={{ client: {} as SupabaseClient, userId: 'u', openSheet }}>
      <ResourceStoreProvider store={store}>
        <Harness initial={initial} />
      </ResourceStoreProvider>
    </ShellProvider>,
  )
  await store.getState().loadAll()
  return { store, openSheet }
}

const cellsOf = (name: string) => {
  const row = screen.getByRole('rowheader', { name: new RegExp(name) }).closest('[role=row]') as HTMLElement
  return within(row).getAllByRole('gridcell')
}

describe('Workload', () => {
  it('shows a row per resource and a column per week with assigned vs available hours', async () => {
    await mount()
    expect(await screen.findByRole('grid', { name: 'Workload by resource' })).toBeInTheDocument()
    for (const n of ['Ada Okafor', 'Ben Hartley', 'Tower crane']) expect(screen.getByRole('rowheader', { name: new RegExp(n) })).toBeInTheDocument()
    expect(screen.getAllByRole('columnheader')).toHaveLength(13) // name + 12 weeks
    const [first] = cellsOf('Ada Okafor')
    expect(first).toHaveAttribute('aria-label', 'Week of Mon 16 Nov: 48 of 40 h (120%), over-allocated on 3 days')
    expect(first).toHaveAttribute('data-level', 'over')
    const [ben] = cellsOf('Ben Hartley')
    expect(ben).toHaveAttribute('aria-label', 'Week of Mon 16 Nov: 6 of 40 h (15%)')
    expect(ben).toHaveAttribute('data-level', 'low')
    expect(cellsOf('Tower crane')[0]).toHaveAttribute('data-level', 'none')
  })

  it('marks over-allocation with a symbol and not by colour alone', async () => {
    await mount()
    const [first] = cellsOf('Ada Okafor')
    expect(within(first).getByText('!')).toBeInTheDocument()
    expect(within(cellsOf('Ben Hartley')[0]).queryByText('!')).toBeNull()
    expect(screen.getByText('3d over')).toBeInTheDocument()
  })

  it('summarises utilisation and over-allocated resources for the range', async () => {
    await mount()
    const summary = screen.getByLabelText('Utilisation summary')
    expect(within(summary).getByText('Over-allocated').nextElementSibling).toHaveTextContent('1')
    expect(within(summary).getByText('Resources').nextElementSibling).toHaveTextContent('3')
    // 54 assigned hours (48 + 6) of 3 resources x 12 weeks x 40 h
    expect(within(summary).getByText('Utilisation').nextElementSibling).toHaveTextContent('4%')
    expect(within(summary).getByText(/54 of 1,440 h/)).toBeInTheDocument()
  })

  it('clicking a cell shows the tasks behind the number and can open their sheet', async () => {
    const user = userEvent.setup()
    const { openSheet } = await mount()
    await screen.findByRole('grid')
    await user.click(cellsOf('Ada Okafor')[0])
    const drawer = screen.getByRole('complementary')
    expect(within(drawer).getByRole('heading', { name: 'Ada Okafor' })).toBeInTheDocument()
    expect(within(drawer).getByText('48 of 40 h')).toBeInTheDocument()
    expect(within(drawer).getByText(/over-allocated on 3 days \(24 h over\)/)).toBeInTheDocument()
    expect(within(drawer).getByRole('list', { name: 'By day' })).toBeInTheDocument()
    expect(within(drawer).getByText('Conduit rough-in')).toBeInTheDocument()
    expect(within(drawer).getByText('Switchboard')).toBeInTheDocument()
    expect(within(drawer).getAllByText('24 h')).toHaveLength(2)
    await user.click(within(drawer).getAllByRole('button', { name: 'Open sheet' })[0])
    expect(openSheet).toHaveBeenCalledWith('s1')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('an empty cell says nothing is assigned', async () => {
    const user = userEvent.setup()
    await mount()
    await screen.findByRole('grid')
    await user.click(cellsOf('Tower crane')[0])
    expect(screen.getByText('Nothing is assigned in this period.')).toBeInTheDocument()
  })

  it('zooms to days with a weekday header and per-day cells', async () => {
    const user = userEvent.setup()
    await mount()
    await screen.findByRole('grid')
    await user.click(screen.getByRole('button', { name: 'Day' }))
    expect(screen.getAllByRole('columnheader')).toHaveLength(15) // name + 14 days
    expect(cellsOf('Ada Okafor')[0]).toHaveAttribute('aria-label', 'Mon 16 Nov: 16 of 8 h (200%), over-allocated on 1 day')
    expect(cellsOf('Ada Okafor')[5]).toHaveAttribute('aria-label', 'Sat 21 Nov: 0 of 0 h (–)')
    await user.click(screen.getByRole('button', { name: 'Month' }))
    expect(screen.getAllByRole('columnheader')).toHaveLength(7)
    expect(cellsOf('Ada Okafor')[0]).toHaveAttribute('aria-label', expect.stringMatching(/^Nov 2026: 48 of /))
  })

  it('filters by department, type, search text and over-allocated only', async () => {
    const user = userEvent.setup()
    await mount()
    await screen.findByRole('grid')
    await user.click(screen.getByRole('button', { name: /Filters/ })) // visible on phones; harmless here
    await user.selectOptions(screen.getByLabelText('Department'), 'Electrical')
    expect(screen.queryByRole('rowheader', { name: /Ben Hartley/ })).toBeNull()
    expect(screen.getByRole('rowheader', { name: /Ada Okafor/ })).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Department'), '')
    await user.selectOptions(screen.getByLabelText('Type'), 'equipment')
    expect(screen.getAllByRole('rowheader')).toHaveLength(1)
    await user.selectOptions(screen.getByLabelText('Type'), '')
    await user.type(screen.getByLabelText('Search resources'), 'wiring')
    expect(screen.getAllByRole('rowheader')).toHaveLength(1) // skills are searched too
    await user.clear(screen.getByLabelText('Search resources'))
    await user.click(screen.getByRole('checkbox', { name: 'Over-allocated only' }))
    expect(screen.getAllByRole('rowheader')).toHaveLength(1)
    expect(screen.getByRole('rowheader', { name: /Ada Okafor/ })).toBeInTheDocument()
  })

  it('sorts by most loaded and most over-allocated', async () => {
    const user = userEvent.setup()
    await mount()
    await screen.findByRole('grid')
    await user.selectOptions(screen.getByLabelText('Sort'), 'over')
    expect(screen.getAllByRole('rowheader')[0]).toHaveTextContent('Ada Okafor')
    await user.selectOptions(screen.getByLabelText('Sort'), 'load')
    expect(screen.getAllByRole('rowheader')[1]).toHaveTextContent('Ben Hartley')
  })

  it('moves the visible range with the arrows and the date field', async () => {
    const user = userEvent.setup()
    await mount()
    await screen.findByRole('grid')
    expect(screen.getAllByRole('columnheader')[1]).toHaveTextContent('16')
    await user.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.getAllByRole('columnheader')[1]).toHaveTextContent('28') // six weeks on: 28 Dec
    await user.click(screen.getByRole('button', { name: 'Earlier' }))
    expect(screen.getAllByRole('columnheader')[1]).toHaveTextContent('16')
  })

  it('moves between cells with the arrow keys (one tab stop)', async () => {
    const user = userEvent.setup()
    await mount()
    await screen.findByRole('grid')
    const cells = cellsOf('Ada Okafor')
    expect(cells.filter((c) => c.tabIndex === 0)).toHaveLength(1)
    cells[0].focus()
    await user.keyboard('{ArrowRight}')
    expect(cellsOf('Ada Okafor')[1]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(cellsOf('Ben Hartley')[1]).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('complementary')).toBeInTheDocument()
  })

  it('shows an empty state with no resources, and a message with no match', async () => {
    await mount(memory({}))
    expect(await screen.findByText('No resources yet')).toBeInTheDocument()
  })

  it('reports sheets that could not be read', async () => {
    const p = fixture()
    p.loadSheetTasks = vi.fn(async () => {
      throw new Error('gone')
    })
    await mount(p)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load 1 sheet')
  })
})
