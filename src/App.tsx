import { useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AuthGate } from './auth/AuthGate'
import { SheetList } from './auth/SheetList'
import { createSupabaseClient, getSupabaseConfig } from './lib/supabase'
import { SheetView } from './views/SheetView'
import { Icon } from './ui/Icon'
import { ShellProvider } from './shell/ShellContext'
import { SECTIONS } from './shell/sections'
import './shell/shell.css'
import { NotificationBell } from './automation/NotificationBell'
import { ThemePicker } from './ui/ThemePicker'
import './theme.css'
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
        <Shell client={client} userId={session.user.id} />
      )}
    </AuthGate>
  )
}

function Shell({ client, userId }: { client: SupabaseClient; userId: string }) {
  // A link from an e-mail or a notification can open a sheet directly: /?sheet=<id>.
  const [openSheetId, setOpenSheetId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('sheet'))
  const [sectionId, setSectionId] = useState('sheets')
  // Choosing the section you are already in starts it over (closes an open report or dashboard).
  const [restart, setRestart] = useState(0)
  const section = SECTIONS.find((s) => s.id === sectionId) ?? SECTIONS[0]
  const shell = useMemo(
    () => ({
      client,
      userId,
      openSheet: (id: string) => {
        setOpenSheetId(id)
        setSectionId('sheets')
      },
    }),
    [client, userId],
  )

  return (
    <ShellProvider value={shell}>
    <div className="app">
      <header className="app-header">
        <span className="brand">
          <span className="brand-mark">
            <Icon name="logo" size={18} />
          </span>
          <strong className="brand-name">Construction Work Management</strong>
        </span>
        <nav className="section-nav" aria-label="Main">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-label={s.label}
              aria-current={s.id === section.id ? 'page' : undefined}
              onClick={() => {
                if (s.id === section.id) setRestart((n) => n + 1)
                setSectionId(s.id)
                if (s.id === 'sheets') setOpenSheetId(null)
              }}
            >
              <Icon name={s.icon} size={16} />
              <span className="label">{s.label}</span>
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <NotificationBell />
        <ThemePicker />
      </header>
      <main className={section.id !== 'sheets' ? 'page page-list' : openSheetId === null ? 'page page-list' : 'page page-sheet'}>
        {section.Page ? (
          <section.Page key={restart} />
        ) : openSheetId === null ? (
          <SheetList client={client} userId={userId} onOpen={setOpenSheetId} />
        ) : (
          <SheetView client={client} sheetId={openSheetId} onBack={() => setOpenSheetId(null)} />
        )}
      </main>
    </div>
    </ShellProvider>
  )
}
