import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import * as hierarchy from '../../model/hierarchy'
import { SheetStoreProvider } from '../../store/SheetStoreContext'
import { makeRow, makeSheetData, makeTestStore } from '../../test/fixtures'
import { GridView } from './GridView'

// Count every full tree walk made while the grid renders formula cells.
vi.mock('../../model/hierarchy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../model/hierarchy')>()
  return { ...actual, fullOrder: vi.fn(actual.fullOrder) }
})

describe('formula cell cost', () => {
  it('2,000 rows of =SUM([Cost]) render without a tree walk per formula cell, and re-renders reuse the results', async () => {
    const n = 2000
    const columns = [
      { id: 'task', title: 'Task', type: 'TEXT_NUMBER' as const },
      { id: 'cost', title: 'Cost', type: 'TEXT_NUMBER' as const },
      { id: 'total', title: 'Total', type: 'TEXT_NUMBER' as const },
    ]
    const rows = Array.from({ length: n }, (_, i) =>
      makeRow(`r${i}`, `a${String(i).padStart(5, '0')}`, { task: `T${i + 1}`, cost: 1, total: '=SUM([Cost])' }),
    )
    const { store } = await makeTestStore(makeSheetData({ columns, rows, dependencies: [] }))
    const fullOrder = vi.mocked(hierarchy.fullOrder)
    fullOrder.mockClear()

    render(
      <SheetStoreProvider store={store}>
        <GridView viewportHeight={1400} />
      </SheetStoreProvider>,
    )
    const totals = screen.getAllByText('2000')
    expect(totals.length).toBeGreaterThanOrEqual(40)
    const afterFirstRender = fullOrder.mock.calls.length
    expect(afterFirstRender).toBeLessThanOrEqual(4)

    await userEvent.setup().click(totals[3])
    expect(fullOrder.mock.calls.length).toBe(afterFirstRender)
  })
})
