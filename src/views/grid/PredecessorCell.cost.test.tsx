import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import * as hierarchy from '../../model/hierarchy'
import { SheetStoreProvider } from '../../store/SheetStoreContext'
import { COL, fsDep, makeRow, makeSheetData, makeTestStore } from '../../test/fixtures'
import { GridView } from './GridView'

// Count every full tree walk (row-number build) made while the grid renders.
vi.mock('../../model/hierarchy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../model/hierarchy')>()
  return { ...actual, fullOrder: vi.fn(actual.fullOrder) }
})

describe('predecessor tooltip cost', () => {
  it('a 5,000-row chain renders 40+ predecessor tooltips without a tree walk per cell', async () => {
    const n = 5000
    const rows = Array.from({ length: n }, (_, i) =>
      makeRow(`r${i}`, `a${String(i).padStart(5, '0')}`, i === 0 ? { [COL.task]: 'T1', [COL.start]: '2026-11-09' } : { [COL.task]: `T${i + 1}` }),
    )
    const dependencies = rows.slice(1).map((r, i) => fsDep(rows[i].id, r.id))
    const { store } = await makeTestStore(makeSheetData({ rows, dependencies }))
    const fullOrder = vi.mocked(hierarchy.fullOrder)
    fullOrder.mockClear()

    render(
      <SheetStoreProvider store={store}>
        <GridView viewportHeight={1400} />
      </SheetStoreProvider>,
    )
    const tooltips = screen.getAllByTitle(/^\d+: T\d+$/)
    expect(tooltips.length).toBeGreaterThanOrEqual(40)
    expect(screen.getByTitle('1: T1')).toHaveTextContent('1FS')
    const afterFirstRender = fullOrder.mock.calls.length
    expect(afterFirstRender).toBeLessThanOrEqual(3)

    // Re-rendering (here: selecting a cell) walks the tree no further times.
    await userEvent.setup().click(tooltips[5])
    expect(fullOrder.mock.calls.length).toBe(afterFirstRender)
  })
})
