import { useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AuthGate } from './auth/AuthGate'
import { SheetList } from './auth/SheetList'
import { createSupabaseClient, getSupabaseConfig } from './lib/supabase'
import { SheetView } from './views/SheetView'
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
  return (
    <div className="app">
      <header className="app-header">
        <strong>Construction Work Management</strong>
        <span className="spacer" />
        <span>{email}</span>
        <button type="button" onClick={() => client.auth.signOut()}>
          Sign out
        </button>
      </header>
      <main>
        {openSheetId === null ? (
          <SheetList client={client} userId={userId} onOpen={setOpenSheetId} />
        ) : (
          <SheetView client={client} sheetId={openSheetId} onBack={() => setOpenSheetId(null)} />
        )}
      </main>
    </div>
  )
}
