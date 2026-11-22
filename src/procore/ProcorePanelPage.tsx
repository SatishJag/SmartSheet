/**
 * /procore: Plan with AI inside Procore, as a 400-px side panel or the full-screen app
 * (docs/superpowers/specs/2026-11-22-procore-panel-design.md). Only sign-in and Plan with AI: no app
 * header, sheet list or tools. The project is chosen from the Procore project the page was opened on.
 */
import { useEffect, useRef, useState } from 'react'
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

/** The page's address with the Procore company and project added, so a new tab opens on the same project. */
function withContext(href: string, context: ProcoreContext | null): string {
  if (!context) return href
  try {
    const url = new URL(href)
    url.searchParams.set('company', context.companyId)
    url.searchParams.set('project', context.projectId)
    return url.toString()
  } catch {
    return href
  }
}

export function ProcorePanelPage({ client, location, storage, referrer }: ProcorePanelPageProps) {
  const [canStore] = useState(() => storageAvailable(storage))
  const [context, setContext] = useState<ProcoreContext | null>(() => contextFromSearch(location.search))

  // The side panel learns its project from Procore's setup message (the full screen from its address).
  useEffect(() => listenForProcoreContext(window, referrer ?? document.referrer, setContext), [referrer])

  if (!canStore) {
    return (
      <main className="procore-panel procore-blocked">
        <h1>Plan with AI</h1>
        <p>Your browser blocks sign-in inside Procore.</p>
        <a className="btn btn-primary" href={withContext(location.href, context)} target="_blank" rel="noopener">
          Open Plan with AI in a new tab
        </a>
      </main>
    )
  }
  return (
    <AuthGate client={client}>
      {(session) => <SignedIn client={client} userId={session.user.id} location={location} context={context} />}
    </AuthGate>
  )
}

function SignedIn({ client, userId, location, context }: { client: SupabaseClient; userId: string; location: ProcorePanelPageProps['location']; context: ProcoreContext | null }) {
  const [project, setProject] = useState<string | undefined>(undefined)
  const [created, setCreated] = useState<{ id: string; name?: string } | null>(null)
  const [round, setRound] = useState(0)

  useEffect(() => {
    // A new context replaces the old project: an unmatched one leaves the choice to the planner.
    setProject(undefined)
    if (!context) return
    let live = true
    const controller = new AbortController()
    void (async () => {
      try {
        const match = await requestProjectMatch(await getAccessToken(client), context, { signal: controller.signal })
        if (live) setProject(match.code ?? undefined)
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
      <Created
        name={created.name}
        href={`${location.origin}/?sheet=${encodeURIComponent(created.id)}`}
        onAnother={() => {
          setCreated(null)
          setRound((r) => r + 1)
        }}
      />
    )
  }
  return (
    <main className="procore-main">
      <PlannerWizard
        key={round}
        client={client}
        userId={userId}
        embedded
        initialProject={project}
        onCreated={(id, name) => setCreated({ id, name })}
        // Cancel starts a fresh request: the page has nowhere else to go.
        onClose={() => setRound((r) => r + 1)}
      />
    </main>
  )
}

/** The saved plan: its name, a link to it in the full app, and a way to plan another. Focus moves here. */
function Created({ name, href, onAnother }: { name?: string; href: string; onAnother: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])
  return (
    <main className="procore-panel procore-created">
      <h1 ref={heading} tabIndex={-1}>
        Schedule created
      </h1>
      <p role="status">{name ? `${name} is saved as a sheet in SmartSheet.` : 'Your plan is saved as a sheet in SmartSheet.'}</p>
      <div className="procore-actions">
        <a className="btn btn-primary" href={href} target="_blank" rel="noopener">
          Open in SmartSheet
        </a>
        <button type="button" className="btn" onClick={onAnother}>
          Plan another
        </button>
      </div>
    </main>
  )
}
