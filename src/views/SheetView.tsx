import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { StoreApi } from 'zustand/vanilla'
import { supabasePersistence } from '../store/persistence'
import { SheetStoreProvider, useSheetStore, useSheetStoreApi } from '../store/SheetStoreContext'
import { createSheetStore, type SaveStatus, type SheetState } from '../store/sheetStore'
import { ConfirmDialog } from './ConfirmDialog'
import { ShowCriticalPathProvider } from './criticalPathContext'
import { InlineRename } from './InlineRename'
import { ScheduleSettingsButton } from './ScheduleSettingsDialog'
import { GanttView } from './gantt/GanttView'
import { GridView } from './grid/GridView'
import { SaveStatusBadge } from './grid/SaveStatusBadge'
import { KanbanView } from './kanban/KanbanView'

export interface SheetViewProps {
  client: SupabaseClient
  sheetId: string
  onBack: () => void
  /** Told whenever the sheet's save status changes (the app guards Sign out with it). */
  onSaveStatusChange?: (status: SaveStatus) => void
  /** A ready-made store (tests); by default one is created over Supabase persistence. */
  store?: StoreApi<SheetState>
}

/** Failed saves are retried once automatically this long after the status becomes `failed`. */
export const AUTO_RETRY_MS = 30_000

export const UNSAVED_MESSAGE = 'You have unsaved changes. Leave anyway?'

/** One open sheet. Keyed by sheet id so each sheet gets its own store. */
export function SheetView(props: SheetViewProps) {
  return <SheetViewForSheet key={props.sheetId} {...props} />
}

function SheetViewForSheet({ client, sheetId, onBack, onSaveStatusChange, store: given }: SheetViewProps) {
  // Created once per mounted sheet; useState's initializer is safe under StrictMode.
  const [store] = useState(() => given ?? createSheetStore(supabasePersistence(client)))
  const loadStarted = useRef(false)

  useEffect(() => {
    if (loadStarted.current) return // StrictMode runs effects twice; load once
    loadStarted.current = true
    void store.getState().load(sheetId)
  }, [store, sheetId])

  return (
    <SheetStoreProvider store={store}>
      <SheetContent client={client} sheetId={sheetId} onBack={onBack} onSaveStatusChange={onSaveStatusChange} />
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

/**
 * Keeps unsaved work safe: retries failed saves when the browser comes back online and once
 * AUTO_RETRY_MS after saving fails, warns before the page unloads while anything is unsaved,
 * and reports the status upwards.
 */
function useSaveGuards(onSaveStatusChange?: (status: SaveStatus) => void): SaveStatus {
  const api = useSheetStoreApi()
  const status = useSheetStore((s) => s.saveStatus)

  useEffect(() => {
    const retry = () => api.getState().retryFailed()
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [api])

  useEffect(() => {
    if (status !== 'failed') return
    const timer = setTimeout(() => api.getState().retryFailed(), AUTO_RETRY_MS)
    return () => clearTimeout(timer)
  }, [status, api])

  useEffect(() => {
    if (status === 'saved') return
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = '' // older browsers need returnValue set to show the prompt
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [status])

  const report = useRef(onSaveStatusChange)
  report.current = onSaveStatusChange
  useEffect(() => {
    report.current?.(status)
  }, [status])

  return status
}

/** The sheet's name as the page heading, with an inline Rename that saves to the sheets table. */
function SheetName({ client, sheetId, name }: { client: SupabaseClient; sheetId: string; name: string }) {
  const api = useSheetStoreApi()
  const [editing, setEditing] = useState(false)

  async function save(next: string): Promise<string | null> {
    const { error } = await client.from('sheets').update({ name: next }).eq('id', sheetId)
    if (error) return error.message
    api.getState().setSheetName(next)
    setEditing(false)
    return null
  }

  return editing ? (
    <InlineRename initial={name} onSave={save} onCancel={() => setEditing(false)} />
  ) : (
    <>
      <h2>{name}</h2>
      <button type="button" aria-label="Rename sheet" onClick={() => setEditing(true)}>
        Rename
      </button>
    </>
  )
}

function SheetContent({
  client,
  sheetId,
  onBack,
  onSaveStatusChange,
}: {
  client: SupabaseClient
  sheetId: string
  onBack: () => void
  onSaveStatusChange?: (status: SaveStatus) => void
}) {
  const data = useSheetStore((s) => s.data)
  const loadError = useSheetStore((s) => s.loadError)
  const status = useSaveGuards(onSaveStatusChange)
  const [confirmBack, setConfirmBack] = useState(false)
  const [showCritical, setShowCritical] = useState(false)
  const dependenciesOn = data?.sheet.dependenciesEnabled ?? false

  return (
    <section className="sheet-view">
      {confirmBack && (
        <ConfirmDialog
          title="Unsaved changes"
          message={UNSAVED_MESSAGE}
          confirmLabel="Leave"
          cancelLabel="Stay"
          onConfirm={() => {
            setConfirmBack(false)
            onBack()
          }}
          onCancel={() => setConfirmBack(false)}
        />
      )}
      <header className="sheet-view-header">
        <button type="button" onClick={() => (status === 'saved' ? onBack() : setConfirmBack(true))}>
          Back to sheets
        </button>
        {data && <SheetName client={client} sheetId={sheetId} name={data.sheet.name} />}
        {data && <ScheduleSettingsButton />}
        {data && (
          <label
            className="critical-toggle"
            title={dependenciesOn ? undefined : 'Turn on dependencies in Schedule settings to see the critical path'}
          >
            <input
              type="checkbox"
              checked={showCritical && dependenciesOn}
              disabled={!dependenciesOn}
              onChange={(e) => setShowCritical(e.currentTarget.checked)}
            />{' '}
            Critical path
          </label>
        )}
        <span className="spacer" />
        {data && <SaveStatusBadge />}
      </header>
      {loadError ? (
        <p role="alert">Could not load the sheet: {loadError}</p>
      ) : data ? (
        <ShowCriticalPathProvider value={showCritical && dependenciesOn}>
          <SheetTabs />
        </ShowCriticalPathProvider>
      ) : (
        <p>Loading sheet…</p>
      )}
    </section>
  )
}
