import { createContext, useContext, type ReactNode } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'
import type { SheetState } from './sheetStore'

const SheetStoreContext = createContext<StoreApi<SheetState> | null>(null)

export function SheetStoreProvider({ store, children }: { store: StoreApi<SheetState>; children: ReactNode }) {
  return <SheetStoreContext.Provider value={store}>{children}</SheetStoreContext.Provider>
}

/** The store itself, for calling actions without subscribing. */
export function useSheetStoreApi(): StoreApi<SheetState> {
  const store = useContext(SheetStoreContext)
  if (!store) throw new Error('useSheetStoreApi must be used inside a SheetStoreProvider')
  return store
}

/** Subscribe to a slice of the sheet store. The selector must return a stable value. */
export function useSheetStore<T>(selector: (s: SheetState) => T): T {
  return useStore(useSheetStoreApi(), selector)
}
