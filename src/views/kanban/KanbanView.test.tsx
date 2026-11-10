import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Column } from '../../model/validate'
import type { SheetData } from '../../store/persistence'
import { SheetStoreProvider } from '../../store/SheetStoreContext'
import { COL, fixtureColumns, makeRow, makeSheetData, makeTestStore } from '../../test/fixtures'
import { KanbanView, type KanbanViewProps } from './KanbanView'

async function renderKanban(data: SheetData = makeSheetData(), props: KanbanViewProps = {}) {
  const { store } = await makeTestStore(data)
  const setCell = vi.spyOn(store.getState(), 'setCell')
  render(
    <SheetStoreProvider store={store}>
      <KanbanView {...props} />
    </SheetStoreProvider>,
  )
  return { store, setCell }
}

/** A minimal DataTransfer stand-in: jsdom has none. */
function makeDataTransfer() {
  const items = new Map<string, string>()
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (k: string, v: string) => void items.set(k, v),
    getData: (k: string) => items.get(k) ?? '',
  }
}

const lane = (name: string) => screen.getByRole('region', { name: new RegExp(`^${name} \\(\\d+\\)$`) })
const cardOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement
const cardNames = (laneEl: HTMLElement) =>
  within(laneEl)
    .queryAllByRole('listitem')
    .map((li) => li.querySelector('.kanban-card-name')?.textContent)

function drag(cardName: string, laneName: string) {
  const dataTransfer = makeDataTransfer()
  fireEvent.dragStart(cardOf(cardName), { dataTransfer })
  fireEvent.dragOver(lane(laneName), { dataTransfer })
  fireEvent.drop(lane(laneName), { dataTransfer })
  fireEvent.dragEnd(cardOf(cardName), { dataTransfer })
}

/** Top-level rows with one status each (null = no status cell); ids r0.. */
function flatSheet(statuses: (string | null)[], columns: Column[] = fixtureColumns): SheetData {
  return makeSheetData({
    columns,
    rows: statuses.map((s, i) =>
      makeRow(`r${i}`, `a${String(i).padStart(4, '0')}`, { [COL.task]: `Task ${i}`, ...(s === null ? {} : { [COL.status]: s }) }),
    ),
    dependencies: [],
  })
}

describe('KanbanView lanes and cards', () => {
  it('has a lane per picklist option in order, then No status, with counts in the headers', async () => {
    await renderKanban()
    const regions = screen.getAllByRole('region')
    expect(regions.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Not started (1)',
      'In progress (1)',
      'Done (1)',
      'No status (0)',
    ])
    expect(screen.getByRole('heading', { name: 'In progress (1)' })).toBeInTheDocument()
  })

  it('shows only leaf rows as cards; parent rows are excluded', async () => {
    await renderKanban()
    expect(screen.queryByText('Site preparation')).not.toBeInTheDocument()
    expect(cardNames(lane('Done'))).toEqual(['Survey'])
    expect(cardNames(lane('In progress'))).toEqual(['Clear site'])
    expect(cardNames(lane('Not started'))).toEqual(['Foundations'])
  })

  it('puts a row with an empty status in No status', async () => {
    await renderKanban(flatSheet(['Done', null, '']))
    expect(cardNames(lane('No status'))).toEqual(['Task 1', 'Task 2'])
    expect(lane('No status')).toHaveAccessibleName('No status (2)')
    expect(within(lane('No status')).queryByTestId('raw-value')).not.toBeInTheDocument()
  })

  it('puts a row whose value is not among the options in No status with its raw value as a badge', async () => {
    await renderKanban(flatSheet(['Blocked', 'Done']))
    expect(cardNames(lane('No status'))).toEqual(['Task 0'])
    expect(within(cardOf('Task 0')).getByTestId('raw-value')).toHaveTextContent('Blocked')
    expect(within(cardOf('Task 1')).queryByTestId('raw-value')).not.toBeInTheDocument()
  })

  it('orders cards within a lane by the sheet order', async () => {
    await renderKanban(flatSheet(['Done', 'Done', 'Done']))
    expect(cardNames(lane('Done'))).toEqual(['Task 0', 'Task 1', 'Task 2'])
  })

  it('shows the schedule dates and the percent complete on a card', async () => {
    await renderKanban()
    const survey = within(cardOf('Survey'))
    expect(survey.getByText('2026-11-09 – 2026-11-10')).toBeInTheDocument()
    expect(survey.getByText('100%')).toBeInTheDocument()
    expect(within(cardOf('Clear site')).getByText('50%')).toBeInTheDocument()
  })

  it('omits the percent when the sheet has no percentComplete column', async () => {
    const columns = fixtureColumns.filter((c) => c.role !== 'percentComplete')
    await renderKanban(makeSheetData({ columns }))
    expect(within(cardOf('Survey')).queryByText('100%')).not.toBeInTheDocument()
  })

  it('shows a quiet placeholder in an empty lane', async () => {
    await renderKanban()
    expect(within(lane('No status')).getByText('No cards')).toBeInTheDocument()
    expect(within(lane('Done')).queryByText('No cards')).not.toBeInTheDocument()
  })

  it('renders the empty lanes for a sheet with no rows', async () => {
    await renderKanban(makeSheetData({ rows: [], dependencies: [] }))
    expect(screen.getAllByRole('region')).toHaveLength(4)
    expect(screen.getAllByText('No cards')).toHaveLength(4)
  })
})

describe('KanbanView grouping', () => {
  const extra: Column = { id: 'c-phase', title: 'Phase', type: 'PICKLIST', options: ['Design', 'Build'] }

  it('prefers the role status column over an earlier picklist column', async () => {
    const columns = [extra, ...fixtureColumns]
    await renderKanban(makeSheetData({ columns }))
    expect(screen.getByRole('combobox', { name: 'Group by' })).toHaveValue(COL.status)
    expect(screen.getByRole('region', { name: 'Done (1)' })).toBeInTheDocument()
  })

  it('falls back to the first picklist column when none has the status role', async () => {
    const columns: Column[] = [
      { id: COL.task, title: 'Task', type: 'TEXT_NUMBER' },
      { id: 'c-phase', title: 'Phase', type: 'PICKLIST', options: ['Design', 'Build'] },
      { id: 'c-other', title: 'Other', type: 'PICKLIST', options: ['X'] },
    ]
    const rows = [makeRow('a', 'a0', { [COL.task]: 'A', 'c-phase': 'Build' })]
    await renderKanban(makeSheetData({ columns, rows, dependencies: [] }))
    expect(screen.getByRole('combobox', { name: 'Group by' })).toHaveValue('c-phase')
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Design (0)', 'Build (1)', 'No status (0)'])
  })

  it('honours the groupByColumnId prop', async () => {
    const columns = [...fixtureColumns, extra]
    await renderKanban(makeSheetData({ columns }), { groupByColumnId: 'c-phase' })
    expect(screen.getByRole('combobox', { name: 'Group by' })).toHaveValue('c-phase')
    expect(screen.getByRole('region', { name: 'Design (0)' })).toBeInTheDocument()
  })

  it('lists every picklist column and re-lanes the cards when the grouping changes', async () => {
    const columns = [...fixtureColumns, extra]
    const data = makeSheetData({ columns })
    data.rows = data.rows.map((r) => (r.id === 'r-found' ? { ...r, cells: { ...r.cells, 'c-phase': 'Build' } } : r))
    await renderKanban(data)
    const select = screen.getByRole('combobox', { name: 'Group by' })
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Status', 'Phase'])

    await userEvent.setup().selectOptions(select, 'Phase')
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Design (0)', 'Build (1)', 'No status (2)'])
    expect(cardNames(lane('Build'))).toEqual(['Foundations'])
    expect(cardNames(lane('No status'))).toEqual(['Survey', 'Clear site'])
  })

  it('shows only the message when the sheet has no picklist column', async () => {
    const columns = fixtureColumns.filter((c) => c.type !== 'PICKLIST')
    await renderKanban(makeSheetData({ columns }))
    expect(screen.getByRole('status')).toHaveTextContent('Add a dropdown (picklist) column to use the Kanban board')
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})

describe('KanbanView moving cards', () => {
  it('drops a card on Done: one setCell call, and the card appears in the Done lane', async () => {
    const { setCell } = await renderKanban()
    drag('Foundations', 'Done')
    expect(setCell).toHaveBeenCalledTimes(1)
    expect(setCell).toHaveBeenCalledWith('r-found', COL.status, 'Done')
    expect(cardNames(lane('Done')).sort()).toEqual(['Foundations', 'Survey'])
    expect(cardNames(lane('Not started'))).toEqual([])
    expect(lane('Done')).toHaveAccessibleName('Done (2)')
  })

  it('makes no call when dropping on the current lane', async () => {
    const { setCell } = await renderKanban()
    drag('Survey', 'Done')
    expect(setCell).not.toHaveBeenCalled()
  })

  it('writes an empty value when dropping on No status', async () => {
    const { setCell } = await renderKanban()
    drag('Survey', 'No status')
    expect(setCell).toHaveBeenCalledTimes(1)
    expect(setCell).toHaveBeenCalledWith('r-survey', COL.status, '')
    expect(cardNames(lane('No status'))).toEqual(['Survey'])
  })

  it('does nothing on a drop that carries no dragged card', async () => {
    const { setCell } = await renderKanban()
    fireEvent.drop(lane('Done'), { dataTransfer: makeDataTransfer() })
    expect(setCell).not.toHaveBeenCalled()
  })

  it('sets the drag data and the move effect on dragstart', async () => {
    await renderKanban()
    const dataTransfer = makeDataTransfer()
    const card = cardOf('Survey')
    expect(card).toHaveAttribute('draggable', 'true')
    fireEvent.dragStart(card, { dataTransfer })
    expect(dataTransfer.getData('text/plain')).toBe('r-survey')
    expect(dataTransfer.effectAllowed).toBe('move')
  })

  it('moves with the labelled select just like a drop', async () => {
    const { setCell } = await renderKanban()
    const user = userEvent.setup()
    const select = screen.getByRole('combobox', { name: 'Move Foundations to' })
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Not started', 'In progress', 'Done', 'No status'])
    expect(select).toHaveDisplayValue('Not started')
    await user.selectOptions(select, 'Done')
    expect(setCell).toHaveBeenCalledTimes(1)
    expect(setCell).toHaveBeenCalledWith('r-found', COL.status, 'Done')
    expect(cardNames(lane('Done')).sort()).toEqual(['Foundations', 'Survey'])

    await user.selectOptions(screen.getByRole('combobox', { name: 'Move Survey to' }), 'No status')
    expect(setCell).toHaveBeenLastCalledWith('r-survey', COL.status, '')
  })

  it('shows a setCell error in the status region and leaves the card where it was', async () => {
    const { setCell } = await renderKanban()
    setCell.mockReturnValue({ ok: false, error: 'Choose one of: x' })
    drag('Foundations', 'Done')
    expect(screen.getByRole('status')).toHaveTextContent('Choose one of: x')
    expect(cardNames(lane('Not started'))).toEqual(['Foundations'])
    expect(screen.getByRole('combobox', { name: 'Move Foundations to' })).toHaveDisplayValue('Not started')

    setCell.mockRestore()
    drag('Foundations', 'Done')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(cardNames(lane('Done')).sort()).toEqual(['Foundations', 'Survey'])
  })

  it('marks the lane as a drop target while dragged over, and clears it on leave, drop and dragend', async () => {
    await renderKanban()
    const dataTransfer = makeDataTransfer()
    fireEvent.dragStart(cardOf('Survey'), { dataTransfer })
    expect(cardOf('Survey')).toHaveClass('is-dragging')

    fireEvent.dragOver(lane('In progress'), { dataTransfer })
    expect(lane('In progress')).toHaveClass('is-drop-target')
    fireEvent.dragLeave(lane('In progress'), { dataTransfer })
    expect(lane('In progress')).not.toHaveClass('is-drop-target')

    fireEvent.dragOver(lane('In progress'), { dataTransfer })
    fireEvent.drop(lane('In progress'), { dataTransfer })
    expect(lane('In progress')).not.toHaveClass('is-drop-target')

    fireEvent.dragStart(cardOf('Foundations'), { dataTransfer })
    fireEvent.dragOver(lane('Done'), { dataTransfer })
    expect(lane('Done')).toHaveClass('is-drop-target')
    fireEvent.dragEnd(cardOf('Foundations'), { dataTransfer })
    expect(lane('Done')).not.toHaveClass('is-drop-target')
    expect(cardOf('Foundations')).not.toHaveClass('is-dragging')
  })

  it('prevents default on dragover so the lane accepts drops', async () => {
    await renderKanban()
    const notPrevented = fireEvent.dragOver(lane('Done'), { dataTransfer: makeDataTransfer() })
    expect(notPrevented).toBe(false)
  })
})

describe('KanbanView large lanes', () => {
  it('caps a lane at 100 cards and reveals the next 100 with Show more', async () => {
    await renderKanban(flatSheet(Array.from({ length: 250 }, () => 'Done')))
    const user = userEvent.setup()
    expect(lane('Done')).toHaveAccessibleName('Done (250)')
    expect(within(lane('Done')).getAllByRole('listitem')).toHaveLength(100)

    await user.click(within(lane('Done')).getByRole('button', { name: 'Show 100 more' }))
    expect(within(lane('Done')).getAllByRole('listitem')).toHaveLength(200)
    await user.click(within(lane('Done')).getByRole('button', { name: 'Show 50 more' }))
    expect(within(lane('Done')).getAllByRole('listitem')).toHaveLength(250)
    expect(within(lane('Done')).queryByRole('button', { name: /Show/ })).not.toBeInTheDocument()
  })

  it('has no Show more button at exactly 100 cards', async () => {
    await renderKanban(flatSheet(Array.from({ length: 100 }, () => 'Done')))
    expect(within(lane('Done')).getAllByRole('listitem')).toHaveLength(100)
    expect(within(lane('Done')).queryByRole('button', { name: /Show/ })).not.toBeInTheDocument()
  })
})
