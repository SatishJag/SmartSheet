import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SheetStoreProvider } from '../../store/SheetStoreContext'
import { makeTestStore } from '../../test/fixtures'
import { SaveStatusBadge } from './SaveStatusBadge'

async function renderBadge() {
  const { store } = await makeTestStore()
  render(
    <SheetStoreProvider store={store}>
      <SaveStatusBadge />
    </SheetStoreProvider>,
  )
  return store
}

describe('SaveStatusBadge', () => {
  it('shows each save status, with a prominent alert only when saving failed', async () => {
    const store = await renderBadge()
    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    act(() => store.setState({ saveStatus: 'saving' }))
    expect(screen.getByText('Saving…')).toBeInTheDocument()
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()

    act(() => store.setState({ saveStatus: 'unsaved' }))
    expect(screen.getByText('Unsaved changes — retrying…')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    act(() => store.setState({ saveStatus: 'failed' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Some changes could not be saved')

    act(() => store.setState({ saveStatus: 'saved' }))
    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders store notices in a status region', async () => {
    const store = await renderBadge()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    act(() =>
      store.setState({ notices: ['Removed 2 dependencies that referenced deleted rows', 'Another notice'] }),
    )
    const region = screen.getByRole('status')
    expect(region).toHaveTextContent('Removed 2 dependencies that referenced deleted rows')
    expect(region).toHaveTextContent('Another notice')
  })
})
