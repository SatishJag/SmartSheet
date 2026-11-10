import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'

interface AuthGateProps {
  client: SupabaseClient
  children: (session: Session) => ReactNode
}

export function AuthGate({ client, children }: AuthGateProps) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      if (active) setSession(next)
    })
    client.auth.getSession().then(({ data: { session: initial } }) => {
      if (!active) return
      // Do not clobber a session already delivered by the subscription.
      setSession((current) => current ?? initial)
      setLoading(false)
    })
    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [client])

  if (loading) return <p className="auth-status">Loading...</p>
  if (session) return <>{children(session)}</>
  return <SignInForm client={client} />
}

function SignInForm({ client }: { client: SupabaseClient }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submitLabel = mode === 'signin' ? 'Sign in' : 'Create account'

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      if (mode === 'signin') {
        const { error: err } = await client.auth.signInWithPassword({ email, password })
        if (err) setError(err.message)
      } else {
        const { data, error: err } = await client.auth.signUp({ email, password })
        if (err) setError(err.message)
        else if (!data.session) setNotice('Check your email to confirm your account')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  function toggleMode() {
    setMode(mode === 'signin' ? 'signup' : 'signin')
    setError(null)
    setNotice(null)
  }

  return (
    <form className="auth-form" onSubmit={onSubmit}>
      <h1>{mode === 'signin' ? 'Sign in' : 'Create account'}</h1>
      <label>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          required
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <button type="submit" disabled={busy}>
        {submitLabel}
      </button>
      <button type="button" className="link-button" onClick={toggleMode}>
        {mode === 'signin' ? 'Create account' : 'Have an account? Sign in'}
      </button>
    </form>
  )
}
