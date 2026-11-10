import { useEffect, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabasePersistence } from '../store/persistence'
import { SheetStoreProvider, useSheetStore } from '../store/SheetStoreContext'
import { createSheetStore } from '../store/sheetStore'
import { GridView } from './grid/GridView'
import { SaveStatusBadge } from './grid/SaveStatusBadge'

export interface SheetViewProps {
  client: SupabaseClient
  sheetId: string
  onBack: () => void
}

/** One open sheet. Keyed by sheet id so each sheet gets its own store. */
export function SheetView(props: SheetViewProps) {
  return <SheetViewForSheet key={props.sheetId} {...props} />
}

function SheetViewForSheet({ client, sheetId, onBack }: SheetViewProps) {
  // Created once per mounted sheet; useState's initializer is safe under StrictMode.
  const [store] = useState(() => createSheetStore(supabasePersistence(client)))
  const loadStarted = useRef(false)

  useEffect(() => {
    if (loadStarted.current) return // StrictMode runs effects twice; load once
    loadStarted.current = true
    void store.getState().load(sheetId)
  }, [store, sheetId])

  return (
    <SheetStoreProvider store={store}>
      <SheetContent onBack={onBack} />
    </SheetStoreProvider>
  )
}

function SheetContent({ onBack }: { onBack: () => void }) {
  const data = useSheetStore((s) => s.data)
  const loadError = useSheetStore((s) => s.loadError)

  return (
    <section className="sheet-view">
      <header className="sheet-view-header">
        <button type="button" onClick={onBack}>
          Back to sheets
        </button>
        {data && <h2>{data.sheet.name}</h2>}
        <span className="spacer" />
        {data && <SaveStatusBadge />}
      </header>
      {loadError ? (
        <p role="alert">Could not load the sheet: {loadError}</p>
      ) : data ? (
        <GridView />
      ) : (
        <p>Loading sheet…</p>
      )}
    </section>
  )
}
