import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { SheetData } from '../../store/persistence'
import { SheetStoreProvider } from '../../store/SheetStoreContext'
import { COL, fsDep, makeRow, makeSheetData, makeTestStore } from '../../test/fixtures'
import { ShowCriticalPathProvider } from '../criticalPathContext'
import { GanttView } from './GanttView'

// 2026-11-09 is a Monday. A(3d) -> B(2d) -> D(1d) and A -> C(1d) -> D: B is on the longest chain,
// C has one working day of float (D starts Monday 11-16, C runs Thursday 11-12).
function network(): SheetData {
  const row = (id: string, i: number, name: string, dur: string, start?: string) =>
    makeRow(id, `a${i}`, { [COL.task]: name, [COL.duration]: dur, ...(start ? { [COL.start]: start } : {}) })
  return makeSheetData({
    rows: [row('A', 0, 'Excavate', '3d', '2026-11-09'), row('B', 1, 'Frame', '2d'), row('C', 2, 'Inspect', '1d'), row('D', 3, 'Handover', '1d')],
    dependencies: [fsDep('A', 'B'), fsDep('A', 'C'), fsDep('B', 'D'), fsDep('C', 'D')],
  })
}

async function renderGantt(show: boolean, data = network()) {
  const { store } = await makeTestStore(data)
  render(
    <SheetStoreProvider store={store}>
      <ShowCriticalPathProvider value={show}>
        <GanttView viewportHeight={600} dayWidth={28} today="2026-01-01" />
      </ShowCriticalPathProvider>
    </SheetStoreProvider>,
  )
  return { store }
}

const bar = (name: string) => screen.getByRole('img', { name: new RegExp(`^${name}:`) })

describe('Gantt critical path view', () => {
  it('draws critical bars and links in the critical colour and leaves the others alone', async () => {
    await renderGantt(true)
    for (const name of ['Excavate', 'Frame', 'Handover']) expect(bar(name)).toHaveClass('is-critical')
    expect(bar('Inspect')).not.toHaveClass('is-critical')
    const arrows = [...document.querySelectorAll('[data-testid="dep-arrow"]')]
    expect(arrows).toHaveLength(4)
    expect(arrows.filter((a) => a.getAttribute('data-critical') === 'true')).toHaveLength(2) // A->B and B->D
  })

  it('shows float beside each task, in the bar label, and a critical badge', async () => {
    await renderGantt(true)
    expect(screen.getAllByText('Critical')).toHaveLength(3)
    expect(screen.getByText('1d float')).toBeInTheDocument()
    expect(bar('Inspect')).toHaveAccessibleName(/Total float 1 working day, free float 1 working day/)
    expect(bar('Frame')).toHaveAccessibleName(/On the critical path/)
  })

  it('is off by default: no critical styling, badges or float text', async () => {
    await renderGantt(false)
    expect(document.querySelector('.is-critical')).toBeNull()
    expect(screen.queryByText('Critical')).not.toBeInTheDocument()
    expect(screen.queryByText('1d float')).not.toBeInTheDocument()
    expect(bar('Inspect')).not.toHaveAccessibleName(/float/)
  })

  it('shows nothing when dependencies are turned off (there is no network to analyse)', async () => {
    const data = network()
    data.sheet.dependenciesEnabled = false
    await renderGantt(true, data)
    expect(document.querySelector('.is-critical')).toBeNull()
    expect(screen.queryByText('Critical')).not.toBeInTheDocument()
  })

  it('updates when the schedule changes: lengthening the short branch makes it critical', async () => {
    const { store } = await renderGantt(true)
    // Inspect from 1d to 5d outlasts Frame, so the chain through it becomes the critical one.
    const { act } = await import('@testing-library/react')
    act(() => {
      store.getState().setCell('C', COL.duration, '5d')
    })
    expect(bar('Inspect')).toHaveClass('is-critical')
    expect(bar('Frame')).not.toHaveClass('is-critical')
    expect(screen.getByText('3d float')).toBeInTheDocument() // Frame: 2d task vs 5d branch
  })
})
