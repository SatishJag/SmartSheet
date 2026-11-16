import { useState, useSyncExternalStore } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { StoreApi } from 'zustand/vanilla'
import { supabasePersistence } from '../store/persistence'
import { createSheetStore, type ActionResult, type SaveStatus, type SheetState } from '../store/sheetStore'
import { toSourceSheet } from './sheetSource'
import type { SourceSheet } from './types'

/**
 * The source sheets of a report or dashboard: each is loaded into its OWN sheet store (the same store the
 * sheet view uses), so an edit made in a report goes through `setCell` of the source sheet: validation,
 * rescheduling, the save queue with retries, all unchanged. The hub only holds the stores and tells
 * subscribers when any of them changes.
 */

export type HubLoadState = 'loading' | 'ready' | 'error'

export interface SheetHub {
  /** Loads the sheets that are not loaded yet. Resolves when each is ready or failed. */
  load(ids: readonly string[]): Promise<void>
  /** Loads the given sheets (or all) again from the backend. Edits still saving are written first. */
  reload(ids?: readonly string[]): Promise<void>
  sheet(id: string): SourceSheet | null
  loadState(id: string): HubLoadState | undefined
  loadError(id: string): string | null
  /** Edits one cell of a source sheet as the sheet view would. */
  setCell(sheetId: string, rowId: string, colId: string, raw: string): ActionResult
  /** `failed` when any sheet has unsaved changes it gave up on, `saving` while any is writing. */
  saveStatus(): SaveStatus
  retryFailed(): void
  /** Changes whenever anything the hub holds changes (for useSyncExternalStore). */
  version(): number
  subscribe(listener: () => void): () => void
}

type StoreFactory = (client: SupabaseClient) => StoreApi<SheetState>

interface Entry {
  store: StoreApi<SheetState>
  state: HubLoadState
  error: string | null
}

const defaultFactory: StoreFactory = (client) => createSheetStore(supabasePersistence(client))

/**
 * Stores that still have edits to write, across all hubs. A hub whose page was left keeps saving in the
 * background; a new hub waits for those saves before it loads, so it never reads a stale copy.
 */
const unsaved = new Set<StoreApi<SheetState>>()

function whenIdle(store: StoreApi<SheetState>): Promise<void> {
  const idle = () => {
    const s = store.getState().saveStatus
    return s === 'saved' || s === 'failed'
  }
  if (idle()) return Promise.resolve()
  return new Promise((resolve) => {
    const off = store.subscribe(() => {
      if (idle()) {
        off()
        resolve()
      }
    })
  })
}

const settleUnsaved = () => Promise.all([...unsaved].map((s) => whenIdle(s)))

export function createSheetHub(client: SupabaseClient, factory: StoreFactory = defaultFactory): SheetHub {
  const entries = new Map<string, Entry>()
  const listeners = new Set<() => void>()
  let version = 0
  const changed = () => {
    version++
    for (const l of [...listeners]) l()
  }

  async function loadInto(id: string, entry: Entry): Promise<void> {
    entry.state = 'loading'
    entry.error = null
    changed()
    await entry.store.getState().load(id)
    const s = entry.store.getState()
    entry.state = s.loadError || !s.data ? 'error' : 'ready'
    entry.error = s.loadError
    changed()
  }

  return {
    async load(ids) {
      const fresh = ids.filter((id) => !entries.has(id))
      if (fresh.length === 0) return
      await settleUnsaved()
      await Promise.all(
        fresh.map((id) => {
          if (entries.has(id)) return Promise.resolve()
          const store = factory(client)
          const entry: Entry = { store, state: 'loading', error: null }
          store.subscribe(() => {
            const status = store.getState().saveStatus
            if (status === 'saved' || status === 'failed') unsaved.delete(store)
            else unsaved.add(store)
            changed()
          })
          entries.set(id, entry)
          return loadInto(id, entry)
        }),
      )
    },

    async reload(ids) {
      await Promise.all(
        (ids ?? [...entries.keys()]).map(async (id) => {
          const entry = entries.get(id)
          if (!entry) return
          await whenIdle(entry.store)
          await loadInto(id, entry)
        }),
      )
    },

    sheet(id) {
      const s = entries.get(id)?.store.getState()
      return s?.data ? toSourceSheet(s.data, s.scheduled) : null
    },
    loadState: (id) => entries.get(id)?.state,
    loadError: (id) => entries.get(id)?.error ?? null,

    setCell(sheetId, rowId, colId, raw) {
      const entry = entries.get(sheetId)
      if (!entry || entry.state !== 'ready') return { ok: false, error: 'That sheet is not loaded' }
      return entry.store.getState().setCell(rowId, colId, raw)
    },

    saveStatus() {
      let status: SaveStatus = 'saved'
      for (const { store } of entries.values()) {
        const s = store.getState().saveStatus
        if (s === 'failed') return 'failed'
        if (s !== 'saved') status = s
      }
      return status
    },

    retryFailed() {
      for (const { store } of entries.values()) if (store.getState().saveStatus === 'failed') store.getState().retryFailed()
    },

    version: () => version,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** One hub for the life of a component. Re-renders when any of its sheets changes. */
export function useSheetHub(client: SupabaseClient): SheetHub {
  const [hub] = useState(() => createSheetHub(client))
  useSyncExternalStore(hub.subscribe, hub.version)
  return hub
}
