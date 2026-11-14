import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SheetStoreProvider } from '../../store/SheetStoreContext'
import { COL, makeRow, makeSheetData, makeTestStore } from '../../test/fixtures'
import { ShowCriticalPathProvider } from '../criticalPathContext'
import { GridView } from './GridView'

const sheet = () =>
  makeSheetData({
    rows: [
      makeRow('A', 'a0', { [COL.task]: 'Long', [COL.start]: '2026-11-09', [COL.duration]: '5d' }),
      makeRow('B', 'a1', { [COL.task]: 'Short', [COL.start]: '2026-11-09', [COL.duration]: '2d' }),
    ],
    dependencies: [],
  })

async function renderGrid(show: boolean) {
  const { store } = await makeTestStore(sheet())
  render(
    <SheetStoreProvider store={store}>
      <ShowCriticalPathProvider value={show}>
        <GridView viewportHeight={600} />
      </ShowCriticalPathProvider>
    </SheetStoreProvider>,
  )
}

const rowHeader = (n: number) => screen.getAllByRole('rowheader').find((h) => h.textContent?.trim() === String(n))!

describe('Grid critical path view', () => {
  it('flags critical rows and describes every row\'s float in its row-number tooltip', async () => {
    await renderGrid(true)
    expect(rowHeader(1).closest('[role="row"]')).toHaveClass('is-critical')
    expect(rowHeader(1)).toHaveAttribute('title', 'On the critical path: no float')
    expect(rowHeader(2).closest('[role="row"]')).not.toHaveClass('is-critical')
    expect(rowHeader(2)).toHaveAttribute('title', 'Total float 3 working days, free float 3 working days')
  })

  it('adds nothing when the critical path view is off', async () => {
    await renderGrid(false)
    expect(document.querySelector('.is-critical')).toBeNull()
    expect(rowHeader(1)).not.toHaveAttribute('title')
  })
})
