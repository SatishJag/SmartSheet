import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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

  it('when saving failed, states how many changes failed and offers Retry', async () => {
    const store = await renderBadge()
    const retry = vi.spyOn(store.getState(), 'retryFailed').mockImplementation(() => {})
    act(() => store.setState({ saveStatus: 'failed', failedCount: 3 }))
    expect(screen.getByRole('alert')).toHaveTextContent('3 changes could not be saved')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
    act(() => store.setState({ failedCount: 1 }))
    expect(screen.getByRole('alert')).toHaveTextContent('1 change could not be saved')
    act(() => store.setState({ saveStatus: 'saved', failedCount: 0 }))
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('renders store notices in a status region that is always present (so additions are announced)', async () => {
    const store = await renderBadge()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    act(() =>
      store.setState({ notices: ['Removed 2 dependencies that referenced deleted rows', 'Another notice'] }),
    )
    const region = screen.getByRole('status')
    expect(region).toHaveTextContent('Removed 2 dependencies that referenced deleted rows')
    expect(region).toHaveTextContent('Another notice')
  })

  it('dismisses a notice with its Dismiss button', async () => {
    const store = await renderBadge()
    act(() => store.setState({ notices: ['First notice', 'Second notice'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: First notice' }))
    expect(store.getState().notices).toEqual(['Second notice'])
    expect(screen.queryByText('First notice')).not.toBeInTheDocument()
  })
})
