import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { vi } from 'vitest'
import { ShellProvider } from '../shell/ShellContext'
import { supabaseAssetsPersistence } from './assetsApi'
import { createAssetsStore } from './assetsStore'
import { testBackend, type SeedSheet, type TestBackend } from './testBackend'
import { AssetsStoreProvider } from './useAssets'

/** Test helper: renders a page inside the shell context over the in-memory fake backend. Only tests import this file. */
export function renderAssets(ui: ReactElement, sheets: (string | SeedSheet)[] = []) {
  const backend: TestBackend = testBackend(sheets)
  const store = createAssetsStore(supabaseAssetsPersistence(backend.client), { saveDelayMs: 5 })
  const openSheet = vi.fn()
  const view = render(
    <ShellProvider value={{ client: backend.client, userId: backend.userId, email: 'user@example.com', openSheet }}>
      <AssetsStoreProvider store={store}>{ui}</AssetsStoreProvider>
    </ShellProvider>,
  )
  return { ...backend, store, openSheet, ...view }
}
