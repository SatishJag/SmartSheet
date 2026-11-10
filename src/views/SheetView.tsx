import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabasePersistence } from '../store/persistence'
import { SheetStoreProvider, useSheetStore } from '../store/SheetStoreContext'
import { createSheetStore } from '../store/sheetStore'
import { GanttView } from './gantt/GanttView'
import { GridView } from './grid/GridView'
import { SaveStatusBadge } from './grid/SaveStatusBadge'
import { KanbanView } from './kanban/KanbanView'

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

interface SheetTab {
  id: string
  label: string
  render(): ReactNode
}

/** The sheet's views, in tab order. Only the active one is mounted; the store keeps the data. */
const SHEET_TABS: readonly SheetTab[] = [
  { id: 'grid', label: 'Grid', render: () => <GridView /> },
  { id: 'gantt', label: 'Gantt', render: () => <GanttView /> },
  { id: 'kanban', label: 'Kanban', render: () => <KanbanView /> },
]

function SheetTabs() {
  const [activeId, setActiveId] = useState(SHEET_TABS[0].id)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const baseId = useId()
  const active = SHEET_TABS.find((t) => t.id === activeId) ?? SHEET_TABS[0]

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = SHEET_TABS.findIndex((t) => t.id === active.id)
    const n = SHEET_TABS.length
    const next =
      e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (next < 0) return
    e.preventDefault()
    const id = SHEET_TABS[next].id
    setActiveId(id)
    tabRefs.current.get(id)?.focus()
  }

  return (
    <>
      <div role="tablist" aria-label="Sheet views" className="sheet-tabs" onKeyDown={onKeyDown}>
        {SHEET_TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              if (el) tabRefs.current.set(t.id, el)
              else tabRefs.current.delete(t.id)
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${t.id}`}
            aria-selected={t.id === active.id}
            aria-controls={`${baseId}-panel`}
            tabIndex={t.id === active.id ? 0 : -1}
            className={t.id === active.id ? 'sheet-tab is-active' : 'sheet-tab'}
            onClick={() => setActiveId(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${active.id}`} className="sheet-tabpanel">
        {active.render()}
      </div>
    </>
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
        <SheetTabs />
      ) : (
        <p>Loading sheet…</p>
      )}
    </section>
  )
}
