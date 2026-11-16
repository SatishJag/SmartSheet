import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Chart } from './Chart'
import { DashboardsPage } from './DashboardsPage'
import { renderAssets } from './testRender'
import { TimelineChart } from './TimelineChart'
import type { ChartKind } from './types'
import type { ChartData, TimeData } from './widgetData'

const TASKS = {
  name: 'Tasks',
  columns: [['Task'], ['Status', 'PICKLIST', ['Open', 'Done']], ['Cost'], ['Start', 'DATE'], ['End', 'DATE']] as [string, ('PICKLIST' | 'DATE' | undefined)?, string[]?][],
  rows: [
    ['Dig', 'Open', 1200, '2026-11-02', '2026-11-10'],
    ['Pour', 'Done', 3400, '2026-11-12', '2026-11-20'],
    ['Frame', 'Open', 800, '2026-11-21', null],
  ],
}

async function newDashboard(user: ReturnType<typeof userEvent.setup>, name = 'Board') {
  await screen.findByRole('heading', { name: 'Dashboards' })
  await user.click(screen.getByRole('button', { name: 'New dashboard' }))
  const dialog = await screen.findByRole('dialog', { name: 'New dashboard' })
  await user.type(within(dialog).getByRole('textbox'), name)
  await user.click(within(dialog).getByRole('button', { name: 'Create' }))
  await screen.findByRole('button', { name: 'Add widget' })
}

async function addWidget(user: ReturnType<typeof userEvent.setup>, type: string) {
  await user.click(screen.getByRole('button', { name: 'Add widget' }))
  await user.click(await screen.findByRole('menuitem', { name: type }))
}

describe('DashboardsPage', () => {
  it('builds a dashboard with a metric and a chart over a sheet, arranges it, and saves the layout', async () => {
    const ctx = renderAssets(<DashboardsPage />, [TASKS])
    const user = userEvent.setup()
    await newDashboard(user)
    expect(screen.getByText('This dashboard is empty')).toBeInTheDocument()

    // A metric: the sum of Cost.
    await addWidget(user, 'Metric')
    let dialog = await screen.findByRole('dialog', { name: 'Metric settings' })
    await user.type(within(dialog).getByLabelText('Widget title (optional)'), 'Total cost')
    await user.selectOptions(within(dialog).getByLabelText('Data from'), 'Tasks')
    await user.selectOptions(await within(dialog).findByLabelText('Calculate'), 'Sum')
    await user.selectOptions(within(dialog).getByLabelText('Column'), 'Cost')
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
    const metric = await screen.findByRole('listitem', { name: 'Total cost' })
    await waitFor(() => expect(within(metric).getByRole('status', { hidden: true })).toHaveTextContent(/5.?400/))

    // A chart: rows per status.
    await addWidget(user, 'Chart')
    dialog = await screen.findByRole('dialog', { name: 'Chart settings' })
    await user.type(within(dialog).getByLabelText('Widget title (optional)'), 'By status')
    await user.selectOptions(within(dialog).getByLabelText('Data from'), 'Tasks')
    await user.selectOptions(await within(dialog).findByLabelText('Group by (categories)'), 'Status')
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
    const chart = await screen.findByRole('listitem', { name: 'By status' })
    const img = await within(chart).findByRole('img', { name: /By status: column chart of 2 values/ })
    expect(img).toBeInTheDocument()
    const table = within(chart).getByRole('table', { hidden: true })
    expect(within(table).getAllByRole('row', { hidden: true }).map((r) => r.textContent)).toEqual(['CategoryCount', 'Open2', 'Done1'])

    // The keyboard moves a widget by one cell (Shift resizes); the grid never lets two overlap.
    const grip = within(metric).getByRole('button', { name: /^Move Total cost\./ })
    grip.focus()
    await user.keyboard('{ArrowRight}')
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    const widgets = () => ctx.store.getState().dashboards[0].layout.widgets
    expect(widgets().find((w) => w.title === 'Total cost')).toMatchObject({ x: 1, w: 4 })
    const [a, b] = widgets()
    expect(a.y + a.h <= b.y || b.y + b.h <= a.y || a.x + a.w <= b.x || b.x + b.w <= a.x).toBe(true)

    // Done: view mode, the layout is saved.
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('button', { name: 'Add widget' })).toBeNull()
    await ctx.store.getState().flush()
    await waitFor(() => {
      const row = ctx.table('dashboards')[0]
      expect((row.layout as { widgets: unknown[] }).widgets).toHaveLength(2)
    })
  })

  it('deletes a widget after confirming', async () => {
    const ctx = renderAssets(<DashboardsPage />, [TASKS])
    const user = userEvent.setup()
    await newDashboard(user)
    await addWidget(user, 'Title')
    const dialog = await screen.findByRole('dialog', { name: 'Title settings' })
    await user.type(within(dialog).getByLabelText('Heading'), 'Hello')
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
    expect(await screen.findByRole('heading', { name: 'Hello' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete Dashboard title' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete widget' })
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Hello' })).toBeNull())
    expect(ctx.store.getState().dashboards[0].layout.widgets).toHaveLength(0)
  })

  it('moves a widget up or down with the buttons (the way a phone reorders)', async () => {
    const ctx = renderAssets(<DashboardsPage />, [])
    const user = userEvent.setup()
    await newDashboard(user)
    for (const text of ['First', 'Second']) {
      await addWidget(user, 'Text')
      const dialog = await screen.findByRole('dialog', { name: 'Text settings' })
      await user.type(within(dialog).getByLabelText('Widget title (optional)'), text)
      await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
    }
    const order = () => [...ctx.store.getState().dashboards[0].layout.widgets].sort((a, b) => a.y - b.y || a.x - b.x).map((w) => w.title)
    expect(order()).toEqual(['First', 'Second'])
    await user.click(screen.getByRole('button', { name: 'Move Second up' }))
    expect(order()).toEqual(['Second', 'First'])
  })

  it('a shortcut widget opens a report from the dashboard and Back returns to it', async () => {
    const ctx = renderAssets(<DashboardsPage />, [TASKS])
    const user = userEvent.setup()
    await ctx.store.getState().load()
    const report = await ctx.store.getState().createReport('Open tasks')
    if (!report.ok) throw new Error(report.error)
    await newDashboard(user)
    await addWidget(user, 'Shortcuts')
    const dialog = await screen.findByRole('dialog', { name: 'Shortcuts settings' })
    await user.selectOptions(within(dialog).getByLabelText('Link to'), 'A report')
    await user.selectOptions(within(dialog).getByLabelText('Item'), 'Open tasks')
    await user.click(within(dialog).getByRole('button', { name: 'Add link' }))
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))

    await user.click(await screen.findByRole('button', { name: 'Open tasks' }))
    expect(await screen.findByRole('heading', { name: 'Open tasks' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument()
  })
})

const data: ChartData = { categories: ['Open', 'Done', 'Blocked'], series: [{ name: 'Count', values: [5, 3, 0] }] }

describe('Chart', () => {
  it.each<ChartKind>(['column', 'bar', 'line', 'pie', 'donut'])('draws a %s chart with a text alternative', (kind) => {
    render(<Chart data={data} kind={kind} label="Tasks" />)
    expect(screen.getByRole('img', { name: `Tasks: ${kind} chart of 3 values` })).toBeInTheDocument()
    const rows = within(screen.getByRole('table', { hidden: true })).getAllByRole('row', { hidden: true })
    expect(rows.map((r) => r.textContent)).toEqual(['CategoryCount', 'Open5', 'Done3', 'Blocked0'])
  })

  it('stacked: one legend entry per series, each with a distinct colour', () => {
    const stacked: ChartData = { categories: ['A', 'B'], series: [{ name: 'Open', values: [1, 2] }, { name: 'Done', values: [3, 0] }] }
    const { container } = render(<Chart data={stacked} kind="stacked" label="By trade" />)
    expect([...container.querySelectorAll('.chart-legend li')].map((li) => li.textContent)).toEqual(['Open', 'Done'])
    const fills = [...container.querySelectorAll('.chart-swatch')].map((s) => (s as HTMLElement).style.background)
    expect(new Set(fills).size).toBe(2)
  })

  it('a pie legend lists the values and leaves out empty slices', () => {
    const { container } = render(<Chart data={data} kind="pie" label="Tasks" />)
    expect([...container.querySelectorAll('.chart-legend li')].map((li) => li.textContent)).toEqual(['Open5', 'Done3'])
  })
})

describe('TimelineChart', () => {
  const items: TimeData = {
    items: [
      { id: 'a', label: 'Excavate', start: '2026-11-02', end: '2026-11-10', milestone: false },
      { id: 'b', label: 'Handover', start: '2026-11-20', end: '2026-11-20', milestone: true },
    ],
    min: '2026-11-02',
    max: '2026-11-20',
    skipped: 0,
  }
  it.each(['gantt', 'timeline'] as const)('%s draws a bar per item and a diamond for a milestone', (mode) => {
    const { container } = render(<TimelineChart data={items} mode={mode} label="Programme" today="2026-11-05" />)
    expect(screen.getByRole('img', { name: /Programme: 2 items from 2 Nov 2026 to 20 Nov 2026/ })).toBeInTheDocument()
    expect(container.querySelectorAll('.timeline-bar')).toHaveLength(1)
    expect(container.querySelectorAll('.timeline-milestone')).toHaveLength(1)
    expect(container.querySelector('.timeline-today')).not.toBeNull()
  })
  it('draws nothing without items', () => {
    const { container } = render(<TimelineChart data={{ items: [], min: null, max: null, skipped: 0 }} mode="gantt" label="x" today="2026-11-05" />)
    expect(container.firstChild).toBeNull()
  })
})
