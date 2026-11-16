import { useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AuthGate } from './auth/AuthGate'
import { SheetList } from './auth/SheetList'
import { createSupabaseClient, getSupabaseConfig } from './lib/supabase'
import { CreateAppPage } from './apps/CreateAppPage'
import { ResourceManagement } from './rm/ResourceManagement'
import type { SaveStatus } from './store/sheetStore'
import { ConfirmDialog } from './views/ConfirmDialog'
import { SheetView, UNSAVED_MESSAGE } from './views/SheetView'
import './App.css'

export default function App() {
  const config = getSupabaseConfig()
  if (!config) return <NotConfigured />
  return <ConfiguredApp url={config.url} anonKey={config.anonKey} />
}

function NotConfigured() {
  return (
    <main className="screen-message">
      <h1>Supabase is not configured</h1>
      <p>
        Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in a{' '}
        <code>.env.local</code> file (see <code>.env.example</code>), then restart the dev server.
      </p>
    </main>
  )
}

function ConfiguredApp({ url, anonKey }: { url: string; anonKey: string }) {
  const client = useMemo(() => createSupabaseClient({ url, anonKey }), [url, anonKey])
  return (
    <AuthGate client={client}>
      {(session) => (
        <Shell client={client} userId={session.user.id} email={session.user.email ?? ''} />
      )}
    </AuthGate>
  )
}

type Area = 'sheets' | 'resources'

function Shell({ client, userId, email }: { client: SupabaseClient; userId: string; email: string }) {
  const [area, setArea] = useState<Area>('sheets')
  const [openSheetId, setOpenSheetId] = useState<string | null>(null)
  const [creatingApp, setCreatingApp] = useState(false)
  // Save status of the open sheet: leaving it (Sign out, switching area) asks first while unsaved.
  const [sheetStatus, setSheetStatus] = useState<SaveStatus>('saved')
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)
  const unsaved = area === 'sheets' && openSheetId !== null && sheetStatus !== 'saved'
  const signOut = () => void client.auth.signOut()
  /** Runs `leave` now, or after confirmation when the open sheet has unsaved changes. */
  const guard = (leave: () => void) => (unsaved ? setPendingLeave(() => leave) : leave())
  const goTo = (next: Area) =>
    guard(() => {
      if (next === area) return
      setSheetStatus('saved')
      setOpenSheetId(null)
      setCreatingApp(false)
      setArea(next)
    })

  return (
    <div className="app">
      {pendingLeave && (
        <ConfirmDialog
          title="Unsaved changes"
          message={UNSAVED_MESSAGE}
          confirmLabel="Leave"
          cancelLabel="Stay"
          onConfirm={() => {
            const leave = pendingLeave
            setPendingLeave(null)
            leave()
          }}
          onCancel={() => setPendingLeave(null)}
        />
      )}
      <header className="app-header">
        <strong>Construction Work Management</strong>
        <nav className="app-areas" aria-label="Areas">
          <button type="button" aria-current={area === 'sheets' ? 'page' : undefined} onClick={() => goTo('sheets')}>
            Sheets
          </button>
          <button type="button" aria-current={area === 'resources' ? 'page' : undefined} onClick={() => goTo('resources')}>
            Resource Management
          </button>
        </nav>
        <span className="spacer" />
        <span>{email}</span>
        <button type="button" onClick={() => guard(signOut)}>
          Sign out
        </button>
      </header>
      <main>
        {area === 'resources' ? (
          <ResourceManagement
            client={client}
            email={email}
            onOpenSheet={(sheetId) => {
              setCreatingApp(false)
              setArea('sheets')
              setOpenSheetId(sheetId)
            }}
          />
        ) : creatingApp ? (
          <CreateAppPage
            client={client}
            userId={userId}
            onBack={() => setCreatingApp(false)}
            onCreated={(sheetId) => {
              setCreatingApp(false)
              setOpenSheetId(sheetId)
            }}
          />
        ) : openSheetId === null ? (
          <SheetList client={client} userId={userId} onOpen={setOpenSheetId} onCreateApp={() => setCreatingApp(true)} />
        ) : (
          <SheetView
            client={client}
            sheetId={openSheetId}
            onSaveStatusChange={setSheetStatus}
            onBack={() => {
              setSheetStatus('saved')
              setOpenSheetId(null)
            }}
          />
        )}
      </main>
    </div>
  )
}
