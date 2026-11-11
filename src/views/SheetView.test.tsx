import { StrictMode } from 'react'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { supabasePersistence, type SheetData } from '../store/persistence'
import { makeFakePersistence, makeSheetData, makeTestStore } from '../test/fixtures'
import { SheetView } from './SheetView'

vi.mock('../store/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/persistence')>()),
  supabasePersistence: vi.fn(),
}))

const client = {} as SupabaseClient

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.mocked(supabasePersistence).mockReset()
})

describe('SheetView', () => {
  it('shows loading, then the sheet header and grid; loads once under StrictMode', async () => {
    const persistence = makeFakePersistence()
    const pending = deferred<SheetData>()
    persistence.loadSheet.mockReturnValue(pending.promise)
    vi.mocked(supabasePersistence).mockReturnValue(persistence)
    const onBack = vi.fn()

    render(
      <StrictMode>
        <SheetView client={client} sheetId="sheet-1" onBack={onBack} />
      </StrictMode>,
    )
    expect(screen.getByText('Loading sheet…')).toBeInTheDocument()
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()

    pending.resolve(makeSheetData())
    expect(await screen.findByRole('grid')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Tower A' })).toBeInTheDocument()
    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(screen.getByText('Survey')).toBeInTheDocument()
    expect(persistence.loadSheet).toHaveBeenCalledTimes(1)
    expect(persistence.loadSheet).toHaveBeenCalledWith('sheet-1')
    expect(supabasePersistence).toHaveBeenCalledWith(client)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Back to sheets' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('shows the Grid tab by default and switches to Gantt by click, unmounting the grid', async () => {
    vi.mocked(supabasePersistence).mockReturnValue(makeFakePersistence())
    render(<SheetView client={client} sheetId="sheet-1" onBack={() => {}} />)

    expect(await screen.findByRole('grid')).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Grid', 'Gantt', 'Kanban'])
    expect(screen.getByRole('tab', { name: 'Grid' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Gantt' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.queryByRole('region', { name: 'Gantt chart' })).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: 'Gantt' }))
    expect(screen.getByRole('tab', { name: 'Gantt' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('region', { name: 'Gantt chart' })).toBeInTheDocument()
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Gantt')

    await user.click(screen.getByRole('tab', { name: 'Grid' }))
    expect(screen.getByRole('grid')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Gantt chart' })).not.toBeInTheDocument()
  })

  it('switches tabs with the arrow keys and moves focus', async () => {
    vi.mocked(supabasePersistence).mockReturnValue(makeFakePersistence())
    render(<SheetView client={client} sheetId="sheet-1" onBack={() => {}} />)
    await screen.findByRole('grid')

    const user = userEvent.setup()
    const gridTab = screen.getByRole('tab', { name: 'Grid' })
    expect(gridTab).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('tab', { name: 'Gantt' })).toHaveAttribute('tabindex', '-1')
    gridTab.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Gantt' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Gantt' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('region', { name: 'Gantt chart' })).toBeInTheDocument()
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()

    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Kanban' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Kanban' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('region', { name: 'Done (1)' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Gantt chart' })).not.toBeInTheDocument()

    await user.keyboard('{ArrowRight}') // wraps
    expect(screen.getByRole('tab', { name: 'Grid' })).toHaveFocus()
    expect(screen.getByRole('grid')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Done (1)' })).not.toBeInTheDocument()
    await user.keyboard('{ArrowLeft}') // wraps backwards
    expect(screen.getByRole('tab', { name: 'Kanban' })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: 'Grid' })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Kanban' })).toHaveFocus()
  })

  it('switches to Kanban by click, unmounting the previous view', async () => {
    vi.mocked(supabasePersistence).mockReturnValue(makeFakePersistence())
    render(<SheetView client={client} sheetId="sheet-1" onBack={() => {}} />)
    await screen.findByRole('grid')

    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: 'Kanban' }))
    expect(screen.getByRole('tab', { name: 'Kanban' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('combobox', { name: 'Group by' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Done (1)' })).toBeInTheDocument()
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Kanban')

    await user.click(screen.getByRole('tab', { name: 'Gantt' }))
    expect(screen.getByRole('region', { name: 'Gantt chart' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Group by' })).not.toBeInTheDocument()
  })

  describe('unsaved changes', () => {
    async function renderWithStore(onBack = vi.fn(), onSaveStatusChange = vi.fn()) {
      const { store } = await makeTestStore()
      vi.mocked(supabasePersistence).mockReturnValue(makeFakePersistence())
      const view = render(
        <SheetView client={client} sheetId="sheet-1" onBack={onBack} store={store} onSaveStatusChange={onSaveStatusChange} />,
      )
      await screen.findByRole('grid')
      const retry = vi.spyOn(store.getState(), 'retryFailed').mockImplementation(() => {})
      return { store, retry, onBack, onSaveStatusChange, ...view }
    }

    afterEach(() => {
      vi.useRealTimers()
    })

    it('retries failed saves when the browser comes back online', async () => {
      const { store, retry } = await renderWithStore()
      act(() => store.setState({ saveStatus: 'failed', failedCount: 1 }))
      act(() => {
        window.dispatchEvent(new Event('online'))
      })
      expect(retry).toHaveBeenCalledTimes(1)
    })

    it('retries once automatically 30 s after saving failed, and not if the status recovers first', async () => {
      const { store, retry } = await renderWithStore()
      vi.useFakeTimers()
      act(() => store.setState({ saveStatus: 'failed', failedCount: 1 }))
      act(() => vi.advanceTimersByTime(29_000))
      expect(retry).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(1_000))
      expect(retry).toHaveBeenCalledTimes(1)
      act(() => vi.advanceTimersByTime(60_000))
      expect(retry).toHaveBeenCalledTimes(1) // a single timer

      act(() => store.setState({ saveStatus: 'saved', failedCount: 0 }))
      act(() => store.setState({ saveStatus: 'failed', failedCount: 1 }))
      act(() => store.setState({ saveStatus: 'saved', failedCount: 0 }))
      act(() => vi.advanceTimersByTime(60_000))
      expect(retry).toHaveBeenCalledTimes(1) // cleared when the status left failed
    })

    it('guards page unload only while changes are not saved', async () => {
      const { store } = await renderWithStore()
      const unload = () => {
        const e = new Event('beforeunload', { cancelable: true })
        window.dispatchEvent(e)
        return e.defaultPrevented
      }
      expect(unload()).toBe(false)
      act(() => store.setState({ saveStatus: 'saving' }))
      expect(unload()).toBe(true)
      act(() => store.setState({ saveStatus: 'saved' }))
      expect(unload()).toBe(false)
    })

    it('reports the save status to the parent', async () => {
      const { store, onSaveStatusChange } = await renderWithStore()
      act(() => store.setState({ saveStatus: 'failed', failedCount: 1 }))
      expect(onSaveStatusChange).toHaveBeenLastCalledWith('failed')
    })

    it('Back to sheets asks first while changes are unsaved: Stay keeps the sheet, Leave goes back', async () => {
      const { store, onBack } = await renderWithStore()
      act(() => store.setState({ saveStatus: 'failed', failedCount: 2 }))
      const user = userEvent.setup()
      const back = screen.getByRole('button', { name: 'Back to sheets' })
      await user.click(back)
      const dialog = screen.getByRole('alertdialog', { name: 'Unsaved changes' })
      expect(dialog).toHaveAccessibleDescription('You have unsaved changes. Leave anyway?')
      await user.click(within(dialog).getByRole('button', { name: 'Stay' }))
      expect(onBack).not.toHaveBeenCalled()
      expect(back).toHaveFocus()

      await user.click(back)
      await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Leave' }))
      expect(onBack).toHaveBeenCalledTimes(1)
    })

    it('Back to sheets goes straight back when everything is saved', async () => {
      const { onBack } = await renderWithStore()
      await userEvent.setup().click(screen.getByRole('button', { name: 'Back to sheets' }))
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(onBack).toHaveBeenCalledTimes(1)
    })
  })

  it('shows the load error as an alert', async () => {
    const persistence = makeFakePersistence()
    persistence.loadSheet.mockRejectedValue(new Error('permission denied for table sheets'))
    vi.mocked(supabasePersistence).mockReturnValue(persistence)
    render(<SheetView client={client} sheetId="sheet-1" onBack={() => {}} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('permission denied for table sheets')
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to sheets' })).toBeInTheDocument()
  })
})
