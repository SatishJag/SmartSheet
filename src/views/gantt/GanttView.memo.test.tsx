import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SheetStoreProvider } from '../../store/SheetStoreContext'
import { makeTestStore } from '../../test/fixtures'
import { GanttView } from './GanttView'

const calls = vi.hoisted(() => ({ isWorkingDay: 0 }))

vi.mock('../../engine/calendar', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../engine/calendar')>()
  return {
    ...mod,
    isWorkingDay: (...args: Parameters<typeof mod.isWorkingDay>) => {
      calls.isWorkingDay++
      return mod.isWorkingDay(...args)
    },
  }
})

describe('GanttView header and shading memoization', () => {
  it('does not rebuild the day header or weekend shading when only the visible rows change', async () => {
    const { store } = await makeTestStore()
    render(
      <SheetStoreProvider store={store}>
        <GanttView viewportHeight={600} dayWidth={28} today="2026-01-01" />
      </SheetStoreProvider>,
    )
    calls.isWorkingDay = 0
    await userEvent.setup().click(screen.getByRole('button', { name: 'Collapse Site preparation' }))
    expect(screen.getByRole('button', { name: 'Expand Site preparation' })).toBeInTheDocument()
    expect(calls.isWorkingDay).toBe(0)
  })
})
