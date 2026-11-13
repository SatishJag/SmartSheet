import { useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AuthGate } from './auth/AuthGate'
import { SheetList } from './auth/SheetList'
import { createSupabaseClient, getSupabaseConfig } from './lib/supabase'
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

function Shell({ client, userId, email }: { client: SupabaseClient; userId: string; email: string }) {
  const [openSheetId, setOpenSheetId] = useState<string | null>(null)
  // Save status of the open sheet: Sign out asks first while anything is unsaved.
  const [sheetStatus, setSheetStatus] = useState<SaveStatus>('saved')
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const unsaved = openSheetId !== null && sheetStatus !== 'saved'
  const signOut = () => void client.auth.signOut()

  return (
    <div className="app">
      {confirmSignOut && (
        <ConfirmDialog
          title="Unsaved changes"
          message={UNSAVED_MESSAGE}
          confirmLabel="Leave"
          cancelLabel="Stay"
          onConfirm={() => {
            setConfirmSignOut(false)
            signOut()
          }}
          onCancel={() => setConfirmSignOut(false)}
        />
      )}
      <header className="app-header">
        <strong>Construction Work Management</strong>
        <span className="spacer" />
        <span>{email}</span>
        <button type="button" onClick={() => (unsaved ? setConfirmSignOut(true) : signOut())}>
          Sign out
        </button>
      </header>
      <main>
        {openSheetId === null ? (
          <SheetList client={client} userId={userId} onOpen={setOpenSheetId} />
        ) : (
          <SheetView
            client={client}
            userId={userId}
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
