import { createContext, useContext, type ReactNode } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'
import type { ResourceState } from './resourceStore'

const Ctx = createContext<StoreApi<ResourceState> | null>(null)

export function ResourceStoreProvider({ store, children }: { store: StoreApi<ResourceState>; children: ReactNode }) {
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>
}

export function useResourceStoreApi(): StoreApi<ResourceState> {
  const store = useContext(Ctx)
  if (!store) throw new Error('useResourceStoreApi must be used inside a ResourceStoreProvider')
  return store
}

/** Subscribe to a slice of the resource store. The selector must return a stable value. */
export function useResourceStore<T>(selector: (s: ResourceState) => T): T {
  return useStore(useResourceStoreApi(), selector)
}
