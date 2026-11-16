import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'
import { useShell } from '../shell/ShellContext'
import { assetsStoreFor, type AssetsState } from './assetsStore'

const Override = createContext<StoreApi<AssetsState> | null>(null)

/** Tests give a page its own store instead of the shared one of the backend client. */
export function AssetsStoreProvider({ store, children }: { store: StoreApi<AssetsState>; children: ReactNode }) {
  return <Override.Provider value={store}>{children}</Override.Provider>
}

/** The assets store of this app (shared by the Workspaces, Reports and Dashboards pages). */
export function useAssetsApi(): StoreApi<AssetsState> {
  const override = useContext(Override)
  const { client } = useShell()
  return override ?? assetsStoreFor(client)
}

export function useAssets<T>(selector: (s: AssetsState) => T): T {
  return useStore(useAssetsApi(), selector)
}

/** Loads (and reloads) the assets when a page opens; what is already in the store shows at once. */
export function useLoadAssets(): void {
  const api = useAssetsApi()
  useEffect(() => {
    void api.getState().load()
  }, [api])
}
