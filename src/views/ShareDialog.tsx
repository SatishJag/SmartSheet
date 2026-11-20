import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import './confirmDialog.css'

export type ShareRole = 'viewer' | 'editor'

interface Member {
  user_id: string
  email: string
  role: ShareRole
}

export interface ShareDialogProps {
  client: SupabaseClient
  sheetId: string
  sheetName: string
  onClose: () => void
}

const ROLES: { value: ShareRole; label: string }[] = [
  { value: 'viewer', label: 'Can view' },
  { value: 'editor', label: 'Can edit' },
]

/**
 * Owner-only dialog: lists who a sheet is shared with and lets the owner add someone by email
 * (they need an account), change their role or remove them. Access is enforced by the database;
 * this only drives share_sheet() and the sheet_members table.
 */
export function ShareDialog({ client, sheetId, sheetName, onClose }: ShareDialogProps) {
  const titleId = useId()
  const emailId = useId()
  const roleId = useId()
  const emailRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const [members, setMembers] = useState<Member[] | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<ShareRole>('viewer')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const { data, error: err } = await client.from('sheet_members').select('user_id,email,role').eq('sheet_id', sheetId).order('email')
    if (err) setError(`Could not load who this sheet is shared with: ${err.message}`)
    else setMembers(data as Member[])
  }, [client, sheetId])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    emailRef.current?.focus()
    void load()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [load])

  /** A disabled or removed control drops focus to the page; bring it back so Escape still closes the dialog. */
  function keepFocus() {
    if (!dialogRef.current?.contains(document.activeElement)) emailRef.current?.focus()
  }

  async function share(address: string, nextRole: ShareRole): Promise<boolean> {
    setBusy(true)
    setError(null)
    const { error: err } = await client.rpc('share_sheet', { p_sheet: sheetId, p_email: address, p_role: nextRole })
    setBusy(false)
    if (err) setError(err.message)
    else await load()
    keepFocus()
    return !err
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault()
    if (!email.trim()) return setError('Enter an email address')
    if (await share(email, role)) setEmail('')
  }

  async function remove(m: Member) {
    setBusy(true)
    setError(null)
    const { error: err } = await client.from('sheet_members').delete().eq('sheet_id', sheetId).eq('user_id', m.user_id)
    setBusy(false)
    if (err) setError(`Could not remove ${m.email}: ${err.message}`)
    else await load()
    keepFocus()
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation() // keys inside the dialog never reach the grid behind it
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="confirm-backdrop">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="confirm-dialog share-dialog" onKeyDown={onKeyDown}>
        <h2 id={titleId}>Share “{sheetName}”</h2>
        <form onSubmit={(e) => void onAdd(e)} className="share-form">
          <label htmlFor={emailId}>Email</label>
          <input id={emailId} ref={emailRef} type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
          <label htmlFor={roleId}>Role</label>
          <select id={roleId} value={role} onChange={(e) => setRole(e.target.value as ShareRole)} disabled={busy}>
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <button type="submit" disabled={busy}>
            Share
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
        {members === null && !error && <p>Loading…</p>}
        {members !== null && members.length === 0 && <p>Not shared with anyone yet</p>}
        {members !== null && members.length > 0 && (
          <ul className="share-members" aria-label="People with access">
            {members.map((m) => (
              <li key={m.user_id}>
                <span>{m.email}</span>
                <select
                  aria-label={`Role for ${m.email}`}
                  value={m.role}
                  disabled={busy}
                  onChange={(e) => void share(m.email, e.target.value as ShareRole)}
                >
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <button type="button" aria-label={`Remove ${m.email}`} disabled={busy} onClick={() => void remove(m)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="confirm-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
