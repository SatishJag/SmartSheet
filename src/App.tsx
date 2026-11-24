import { useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AuthGate } from './auth/AuthGate'
import { KeepSheetsBanner } from './auth/KeepSheetsBanner'
import { SheetList } from './auth/SheetList'
import { createSupabaseClient, getSupabaseConfig } from './lib/supabase'
import { CreateAppPage } from './apps/CreateAppPage'
import type { SaveStatus } from './store/sheetStore'
import { ConfirmDialog } from './views/ConfirmDialog'
import { SheetView, UNSAVED_MESSAGE } from './views/SheetView'
import { PlannerWizard } from './planner/PlannerWizard'
import { Icon } from './ui/Icon'
import { ShellProvider } from './shell/ShellContext'
import { SECTIONS } from './shell/sections'
import './shell/shell.css'
import { NotificationBell } from './automation/NotificationBell'
import { ThemePicker } from './ui/ThemePicker'
import { AccountMenu } from './shell/AccountMenu'
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
        <>
          <KeepSheetsBanner client={client} user={session.user} />
          <Shell client={client} userId={session.user.id} email={session.user.email ?? ''} />
        </>
      )}
    </AuthGate>
  )
}

function Shell({ client, userId, email }: { client: SupabaseClient; userId: string; email: string }) {
  // A link from an e-mail or a notification can open a sheet directly: /?sheet=<id>.
  const [openSheetId, setOpenSheetId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('sheet'))
  const [sectionId, setSectionId] = useState('sheets')
  const [planning, setPlanning] = useState(false)
  const [creatingApp, setCreatingApp] = useState(false)
  // Choosing the section you are already in starts it over (closes an open report or dashboard).
  const [restart, setRestart] = useState(0)
  // Save status of the open sheet: leaving it (Sign out, another section) asks first while unsaved.
  const [sheetStatus, setSheetStatus] = useState<SaveStatus>('saved')
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)
  const section = SECTIONS.find((s) => s.id === sectionId) ?? SECTIONS[0]
  const unsaved = section.id === 'sheets' && openSheetId !== null && sheetStatus !== 'saved'
  /** Runs `leave` now, or after confirmation when the open sheet has unsaved changes. */
  const guard = (leave: () => void) => (unsaved ? setPendingLeave(() => leave) : leave())
  const shell = useMemo(
    () => ({
      client,
      userId,
      email,
      openSheet: (id: string) => {
        setCreatingApp(false)
        setOpenSheetId(id)
        setSectionId('sheets')
      },
    }),
    [client, userId, email],
  )
  const closeSheet = () => {
    setSheetStatus('saved')
    setOpenSheetId(null)
  }

  return (
    <ShellProvider value={shell}>
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
              title={s.label}
              aria-current={s.id === section.id ? 'page' : undefined}
              onClick={() =>
                guard(() => {
                  if (s.id === section.id) setRestart((n) => n + 1)
                  setSectionId(s.id)
                  if (s.id === 'sheets') {
                    closeSheet()
                    setCreatingApp(false)
                  }
                })
              }
            >
              <Icon name={s.icon} size={16} />
              <span className="label">{s.label}</span>
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <NotificationBell />
        <ThemePicker />
        <AccountMenu email={email} onSignOut={() => guard(() => void client.auth.signOut())} />
      </header>
      <main className={section.id !== 'sheets' || openSheetId === null ? 'page page-list' : 'page page-sheet'}>
        {section.Page ? (
          <section.Page key={restart} />
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
            userId={userId}
            sheetId={openSheetId}
            onSaveStatusChange={setSheetStatus}
            onBack={closeSheet}
            onPlanWithAI={() => setPlanning(true)}
          />
        )}
      </main>
      {planning && (
        <PlannerWizard
          client={client}
          userId={userId}
          onClose={() => setPlanning(false)}
          onCreated={(id) => {
            setPlanning(false)
            setOpenSheetId(id)
          }}
        />
      )}
    </div>
    </ShellProvider>
  )
}
