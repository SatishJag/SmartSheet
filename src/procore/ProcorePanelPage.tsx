/**
 * /procore: Plan with AI inside Procore, as a 400-px side panel or the full-screen app
 * (docs/superpowers/specs/2026-11-22-procore-panel-design.md). Only sign-in and Plan with AI: no app
 * header, sheet list or tools. The project is chosen from the Procore project the page was opened on.
 */
import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AuthGate } from '../auth/AuthGate'
import { getAccessToken, requestProjectMatch } from '../planner/plannerApi'
import { PlannerWizard } from '../planner/PlannerWizard'
import { contextFromSearch, listenForProcoreContext, type ProcoreContext } from './context'
import './procorePanel.css'

export interface ProcorePanelPageProps {
  client: SupabaseClient
  location: Pick<Location, 'search' | 'origin' | 'href'>
  /** The storage the session lives in (tests); defaults to the browser's. */
  storage?: Storage
  /** Who framed the page (tests); defaults to document.referrer. */
  referrer?: string
}

/** Whether the browser lets this page keep data (a sign-in) in its storage. */
export function storageAvailable(storage?: Storage): boolean {
  try {
    const s = storage ?? window.localStorage
    const key = '__smartsheet_storage_check__'
    s.setItem(key, '1')
    s.removeItem(key)
    return true
  } catch {
    return false
  }
}

export function ProcorePanelPage({ client, location, storage, referrer }: ProcorePanelPageProps) {
  const [canStore] = useState(() => storageAvailable(storage))
  if (!canStore) {
    return (
      <main className="procore-panel procore-blocked">
        <h1>Plan with AI</h1>
        <p>Your browser blocks sign-in inside Procore.</p>
        <a className="btn btn-primary" href={location.href} target="_blank" rel="noopener">
          Open Plan with AI in a new tab
        </a>
      </main>
    )
  }
  return (
    <AuthGate client={client}>
      {(session) => <SignedIn client={client} userId={session.user.id} location={location} referrer={referrer} />}
    </AuthGate>
  )
}

function SignedIn({ client, userId, location, referrer }: { client: SupabaseClient; userId: string; location: ProcorePanelPageProps['location']; referrer?: string }) {
  const [context, setContext] = useState<ProcoreContext | null>(() => contextFromSearch(location.search))
  const [project, setProject] = useState<string | undefined>(undefined)
  const [created, setCreated] = useState<string | null>(null)
  const [round, setRound] = useState(0)

  // The side panel learns its project from Procore's setup message (the full screen from its address).
  useEffect(() => listenForProcoreContext(window, referrer ?? document.referrer, setContext), [referrer])

  useEffect(() => {
    if (!context) return
    let live = true
    const controller = new AbortController()
    void (async () => {
      try {
        const match = await requestProjectMatch(await getAccessToken(client), context, { signal: controller.signal })
        if (live && match.code) setProject(match.code)
      } catch {
        // No match: the planner chooses the project, as in the app.
      }
    })()
    return () => {
      live = false
      controller.abort()
    }
  }, [client, context])

  if (created) {
    return (
      <main className="procore-panel procore-created">
        <h1>Schedule created</h1>
        <p>Your plan is saved as a sheet in SmartSheet.</p>
        <div className="procore-actions">
          <a className="btn btn-primary" href={`${location.origin}/?sheet=${encodeURIComponent(created)}`} target="_blank" rel="noopener">
            Open in SmartSheet
          </a>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setCreated(null)
              setRound((r) => r + 1)
            }}
          >
            Plan another
          </button>
        </div>
      </main>
    )
  }
  return (
    <PlannerWizard
      key={round}
      client={client}
      userId={userId}
      embedded
      initialProject={project}
      onCreated={setCreated}
      // Cancel starts a fresh request: the page has nowhere else to go.
      onClose={() => setRound((r) => r + 1)}
    />
  )
}
