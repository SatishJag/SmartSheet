import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Column } from '../model/validate'
import type { SheetData } from '../store/persistence'
import { SheetStoreProvider } from '../store/SheetStoreContext'
import { makeRow, makeSheetData, makeTestStore } from '../test/fixtures'
import { PlannerApiError, requestCommitted } from './plannerApi'
import { ProcoreSyncButton } from './ProcoreSyncButton'
import type { CommittedResponse } from './types'

vi.mock('./plannerApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./plannerApi')>()),
  getAccessToken: vi.fn(async () => 'tok'),
  requestCommitted: vi.fn(),
}))

const client = {} as SupabaseClient
const COLUMNS: Column[] = [
  { id: 'c-task', title: 'Task', type: 'TEXT_NUMBER' },
  { id: 'c-project', title: 'Project', type: 'PICKLIST', options: ['BKK-03 — Bangkok 3'] },
  { id: 'c-cost', title: 'Cost code', type: 'PICKLIST', options: ['CHL — Chiller'] },
  { id: 'c-basis', title: 'Basis', type: 'TEXT_NUMBER' },
]

function sheet(cells: Record<string, unknown>, columns = COLUMNS): SheetData {
  const d = makeSheetData({ columns, rows: [makeRow('a', 'a0', { 'c-task': 'Chiller', ...cells })], dependencies: [] })
  d.sheet.dependenciesEnabled = false
  return d
}
const TAGGED = sheet({ 'c-project': 'BKK-03 — Bangkok 3', 'c-cost': 'CHL — Chiller' })
const RESPONSE: CommittedResponse = { ok: true, projects: [{ code: 'BKK-03', status: 'ok', costCodes: [{ code: 'CHL', committed: 1250000, awarded: true, known: true }] }] }

async function renderButton(data: SheetData) {
  const { store } = await makeTestStore(data)
  const view = render(
    <SheetStoreProvider store={store}>
      <ProcoreSyncButton client={client} />
    </SheetStoreProvider>,
  )
  return { store, ...view }
}

const titles = (data: SheetData | null) => data!.columns.map((c) => c.title)

beforeEach(() => {
  vi.mocked(requestCommitted).mockReset()
})

describe('ProcoreSyncButton', () => {
  it('shows nothing on a sheet without a Cost code column', async () => {
    await renderButton(sheet({}, COLUMNS.filter((c) => c.id !== 'c-cost')))
    expect(screen.queryByRole('button', { name: 'Sync with Procore' })).not.toBeInTheDocument()
  })

  it('syncs and shows the result', async () => {
    let resolve!: (r: CommittedResponse) => void
    vi.mocked(requestCommitted).mockReturnValue(new Promise((r) => (resolve = r)))
    const { store } = await renderButton(TAGGED)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sync with Procore' }))
    expect(screen.getByRole('button', { name: 'Syncing…' })).toBeDisabled()
    expect(vi.mocked(requestCommitted).mock.calls[0].slice(0, 2)).toEqual(['tok', { projects: [{ code: 'BKK-03', costCodes: ['CHL'] }] }])
    resolve(RESPONSE)
    expect(await screen.findByRole('status')).toHaveTextContent(/^Last synced \d\d:\d\d · 1 item updated$/)
    expect(screen.getByRole('button', { name: 'Sync with Procore' })).toBeEnabled()
    const data = store.getState().data!
    expect(titles(data)).toEqual(['Task', 'Project', 'Cost code', 'Committed (Procore)', 'Awarded', 'Basis'])
    const committed = data.columns.find((c) => c.title === 'Committed (Procore)')!.id
    expect(data.rows[0].cells[committed]).toBe(1250000)
  })

  it('says when there is nothing to sync', async () => {
    await renderButton(sheet({ 'c-project': 'BKK-03 — Bangkok 3' }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sync with Procore' }))
    expect(screen.getByRole('status')).toHaveTextContent('Nothing to sync: no rows have both a project in Procore and a cost code.')
    expect(requestCommitted).not.toHaveBeenCalled()
  })

  it('says which projects are not in Procore and writes nothing', async () => {
    vi.mocked(requestCommitted).mockResolvedValue({ ok: true, projects: [{ code: 'BKK-03', status: 'not-in-procore' }] })
    const { store } = await renderButton(TAGGED)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sync with Procore' }))
    expect(await screen.findByRole('status')).toHaveTextContent('BKK-03 is not in Procore')
    expect(titles(store.getState().data)).toEqual(['Task', 'Project', 'Cost code', 'Basis'])
  })

  it('shows errors and writes nothing', async () => {
    vi.mocked(requestCommitted).mockRejectedValue(
      new PlannerApiError('The planning server failed: Could not sync with Procore: Procore is busy; try again in a minute.', 'server', 502),
    )
    const { store } = await renderButton(TAGGED)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sync with Procore' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Could not sync: Procore is busy; try again in a minute.')
    expect(titles(store.getState().data)).toEqual(['Task', 'Project', 'Cost code', 'Basis'])
  })

  it('says why it cannot sync, without asking the server', async () => {
    await renderButton(sheet({ 'c-project': 'BKK-03 — Bangkok 3', 'c-cost': 'A VERY LONG HAND TYPED CODE' }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sync with Procore' }))
    expect(screen.getByRole('status')).toHaveTextContent('Could not sync: The cost code "A VERY LONG HAND TYPED CODE" is longer than 20 characters; fix it and sync again.')
    expect(requestCommitted).not.toHaveBeenCalled()
  })

  it('shows a column problem as the reason', async () => {
    vi.mocked(requestCommitted).mockResolvedValue(RESPONSE)
    await renderButton(sheet({ 'c-project': 'BKK-03 — Bangkok 3', 'c-cost': 'CHL — Chiller' }, [...COLUMNS, { id: 'c-cm', title: 'Committed (Procore)', type: 'DATE' }]))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sync with Procore' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Could not sync: The "Committed (Procore)" column can’t hold amounts.')
  })

  it('aborts on unmount', async () => {
    let signal: AbortSignal | undefined
    let resolve!: (r: CommittedResponse) => void
    vi.mocked(requestCommitted).mockImplementation((_t, _r, opts) => {
      signal = opts?.signal
      return new Promise((r) => (resolve = r))
    })
    const { store, unmount } = await renderButton(TAGGED)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sync with Procore' }))
    unmount()
    expect(signal?.aborted).toBe(true)
    resolve(RESPONSE)
    await new Promise((r) => setTimeout(r, 0))
    expect(titles(store.getState().data)).toEqual(['Task', 'Project', 'Cost code', 'Basis'])
  })
})
