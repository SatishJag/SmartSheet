import { StrictMode } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { supabasePersistence, type SheetData } from '../store/persistence'
import { makeFakePersistence, makeSheetData } from '../test/fixtures'
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
