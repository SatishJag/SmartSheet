import { useEffect, useState, type ReactNode } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'

interface AuthGateProps {
  client: SupabaseClient
  children: (session: Session) => ReactNode
}

/**
 * MVP: no sign-in screen. Each browser gets an anonymous Supabase user on its first visit (kept
 * across reloads), so row-level security still keeps one visitor's sheets from another's and the
 * planner's limits still apply per visitor. Needs "Allow anonymous sign-ins" in the Supabase project.
 */
export function AuthGate({ client, children }: AuthGateProps) {
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      if (active && next) setSession(next)
    })
    ensureSession(client).then(
      (s) => {
        if (active) setSession((current) => current ?? s)
      },
      (err: unknown) => {
        if (active) setError(describe(err))
      },
    )
    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [client, attempt])

  if (session) return <>{children(session)}</>
  if (error) {
    return (
      <main className="screen-message">
        <h1>Could not start the app</h1>
        <p role="alert">{error}</p>
        <button
          type="button"
          onClick={() => {
            setError(null)
            setAttempt((n) => n + 1)
          }}
        >
          Try again
        </button>
      </main>
    )
  }
  return <p className="auth-status">Loading...</p>
}

/** One sign-in per client at a time: React StrictMode runs effects twice, which would make two users. */
const pending = new WeakMap<SupabaseClient, Promise<Session>>()

function ensureSession(client: SupabaseClient): Promise<Session> {
  const inFlight = pending.get(client)
  if (inFlight) return inFlight
  const p = (async () => {
    const { data: current } = await client.auth.getSession()
    if (current.session) return current.session
    const { data, error } = await client.auth.signInAnonymously()
    if (error) throw new Error(error.message)
    if (!data.session) throw new Error('No session was returned.')
    return data.session
  })()
  pending.set(client, p)
  p.catch(() => pending.delete(client)) // let Try again start over
  return p
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/anonymous/i.test(message)) {
    return `${message}. Turn on "Allow anonymous sign-ins" in the Supabase project (Authentication → Sign In / Providers).`
  }
  return message || 'Something went wrong.'
}
