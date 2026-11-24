import { useId, useRef, useState, type FormEvent } from 'react'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import './keepSheets.css'

interface KeepSheetsBannerProps {
  client: SupabaseClient
  user: User
}

/**
 * For a guest (anonymous) account left from before sign-in needed an email: add an email, confirm it, set a
 * password. Supabase keeps the same user, so every sheet stays (docs/superpowers/specs/2026-11-24-keep-guest-
 * sheets-design.md). Progress is kept in the user's metadata, so step 2 also shows in another browser.
 */
export function KeepSheetsBanner({ client, user }: KeepSheetsBannerProps) {
  const meta = (user.user_metadata ?? {}) as { keep_sheets_email?: string; keep_sheets_password_pending?: boolean }
  const [saved, setSaved] = useState(false)
  if (saved) {
    return (
      <div className="keep-sheets" role="status">
        Saved. Sign in with {user.email ?? meta.keep_sheets_email} from now on.
      </div>
    )
  }
  if (user.is_anonymous) return <AddEmail client={client} sentTo={meta.keep_sheets_email ?? null} />
  if (meta.keep_sheets_password_pending) return <SetPassword client={client} onSaved={() => setSaved(true)} />
  return null
}

function AddEmail({ client, sentTo }: { client: SupabaseClient; sentTo: string | null }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState<string | null>(sentTo)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  async function send(e: FormEvent) {
    e.preventDefault()
    if (busyRef.current) return
    const address = email.trim()
    if (!address) return setError('Enter your email')
    busyRef.current = true
    setBusy(true)
    setError(null)
    const { error: err } = await client.auth.updateUser(
      { email: address, data: { keep_sheets_email: address, keep_sheets_password_pending: true } },
      { emailRedirectTo: window.location.origin },
    )
    busyRef.current = false
    setBusy(false)
    if (err) return setError(/already/i.test(err.message) ? "That email already has an account. Sheets can't be moved into it yet; use another email." : err.message)
    setSent(address)
    setOpen(false)
  }

  if (sent && !open) {
    return (
      <div className="keep-sheets" role="status">
        <span>Check {sent} and open the link in this browser.</span>
        <button type="button" className="link-button" onClick={() => setOpen(true)}>
          Use a different email
        </button>
      </div>
    )
  }
  return (
    <div className="keep-sheets">
      <span>You're using a guest account: your sheets are only reachable from this browser.</span>
      {open ? (
        <form className="keep-sheets-form" onSubmit={send} noValidate>
          <label htmlFor={`${id}-email`}>Email</label>
          <input id={`${id}-email`} type="email" className="input" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="submit" className="btn-primary" disabled={busy}>
            Send link
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      ) : (
        <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
          Keep my sheets
        </button>
      )}
    </div>
  )
}

function SetPassword({ client, onSaved }: { client: SupabaseClient; onSaved: () => void }) {
  const id = useId()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (busyRef.current) return
    if (password.length < 6) return setError('Use at least 6 characters')
    if (password !== confirm) return setError('The passwords do not match')
    busyRef.current = true
    setBusy(true)
    setError(null)
    const { error: err } = await client.auth.updateUser({ password, data: { keep_sheets_password_pending: false } })
    busyRef.current = false
    setBusy(false)
    if (err) return setError(err.message)
    onSaved()
  }

  return (
    <div className="keep-sheets">
      <span>Set a password so you can sign in anywhere</span>
      <form className="keep-sheets-form" onSubmit={save} noValidate>
        <label htmlFor={`${id}-password`}>Password</label>
        <input id={`${id}-password`} type="password" className="input" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <label htmlFor={`${id}-confirm`}>Confirm password</label>
        <input id={`${id}-confirm`} type="password" className="input" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <button type="submit" className="btn-primary" disabled={busy}>
          Save
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    </div>
  )
}
