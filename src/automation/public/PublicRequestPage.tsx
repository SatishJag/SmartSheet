/**
 * The page behind an update-request or approval link (/u/:token, /a/:token). No sign-in, no app shell:
 * it talks only to the planning server's public endpoints, shows only what the sender chose, and
 * works one-handed on a phone. It never learns anything about the rest of the sheet.
 */
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Icon } from '../../ui/Icon'
import '../../theme.css'
import '../../App.css'
import './publicPage.css'

interface Field {
  id: string
  title: string
  type: string
  options?: string[]
  value: unknown
  editable: boolean
}
interface UpdateView {
  kind: 'update'
  sheetName: string
  message: string
  expiresAt: string
  fields: Field[]
}
interface ApprovalView {
  kind: 'approval'
  sheetName: string
  message: string
  expiresAt: string
  approveLabel: string
  declineLabel: string
  shown: { title: string; value: string }[]
}
type View = UpdateView | ApprovalView

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; view: View }
  | { phase: 'done'; view: View; text: string }
  | { phase: 'closed'; title: string; text: string }

const CLOSED: Record<string, { title: string; text: string }> = {
  responded: { title: 'Already sent', text: 'This link has already been used. Thank you.' },
  approved: { title: 'Already answered', text: 'This request has already been answered. Thank you.' },
  declined: { title: 'Already answered', text: 'This request has already been answered. Thank you.' },
  expired: { title: 'This link has expired', text: 'Ask the person who sent it for a new one.' },
  revoked: { title: 'Request withdrawn', text: 'The sender withdrew this request.' },
  gone: { title: 'Row not found', text: 'The row this request is about no longer exists.' },
}

async function call(kind: 'u' | 'a', token: string, init?: { body: unknown }) {
  try {
    const res = await fetch(`/api/${kind}/${encodeURIComponent(token)}`, {
      method: init ? 'POST' : 'GET',
      headers: init ? { 'Content-Type': 'application/json' } : undefined,
      ...(init ? { body: JSON.stringify(init.body) } : {}),
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return { status: res.status, body }
  } catch {
    return { status: 0, body: {} as Record<string, unknown> }
  }
}

function closedFor(status: number, body: Record<string, unknown>): { title: string; text: string } {
  const state = typeof body.state === 'string' ? body.state : ''
  if (CLOSED[state]) return CLOSED[state]
  if (status === 404) return { title: 'This link is not valid', text: 'Check that you opened the whole link from the message.' }
  if (status === 429) return { title: 'Too many attempts', text: 'Wait a few minutes and try again.' }
  if (status === 423) return { title: 'This row is locked', text: 'It cannot be changed right now. Ask the sender.' }
  if (status === 503) return { title: 'Not available', text: 'This feature is switched off on the server.' }
  if (status === 0) return { title: 'No connection', text: 'Could not reach the server. Check your connection and reload.' }
  return { title: 'Something went wrong', text: typeof body.error === 'string' ? body.error : 'Try again in a moment.' }
}

export function PublicRequestPage({ kind, token }: { kind: 'u' | 'a'; token: string }) {
  const [state, setState] = useState<State>({ phase: 'loading' })

  useEffect(() => {
    const metas = [
      Object.assign(document.createElement('meta'), { name: 'robots', content: 'noindex, nofollow' }),
      Object.assign(document.createElement('meta'), { name: 'referrer', content: 'no-referrer' }),
    ]
    metas.forEach((m) => document.head.appendChild(m))
    const title = document.title
    document.title = kind === 'u' ? 'Update request' : 'Approval request'
    return () => {
      metas.forEach((m) => m.remove())
      document.title = title
    }
  }, [kind])

  useEffect(() => {
    let live = true
    void call(kind, token).then(({ status, body }) => {
      if (!live) return
      if (status === 200 && (body.kind === 'update' || body.kind === 'approval')) setState({ phase: 'ready', view: body as unknown as View })
      else setState({ phase: 'closed', ...closedFor(status, body) })
    })
    return () => {
      live = false
    }
  }, [kind, token])

  return (
    <main className="pub">
      <header className="pub-brand">
        <span className="brand-mark">
          <Icon name="logo" size={18} />
        </span>
        <strong>Construction Work Management</strong>
      </header>
      <div className="card pub-card">
        {state.phase === 'loading' && (
          <p className="auth-status" role="status">
            Loading…
          </p>
        )}
        {state.phase === 'closed' && (
          <div role="status">
            <h1>{state.title}</h1>
            <p>{state.text}</p>
          </div>
        )}
        {state.phase === 'done' && (
          <div role="status">
            <h1>Thank you</h1>
            <p>{state.text}</p>
          </div>
        )}
        {state.phase === 'ready' && state.view.kind === 'update' && <UpdateForm view={state.view} token={token} onDone={(text) => setState({ phase: 'done', view: state.view, text })} onClosed={(c) => setState({ phase: 'closed', ...c })} />}
        {state.phase === 'ready' && state.view.kind === 'approval' && <ApprovalForm view={state.view} token={token} onDone={(text) => setState({ phase: 'done', view: state.view, text })} onClosed={(c) => setState({ phase: 'closed', ...c })} />}
      </div>
      <p className="pub-foot">This link is private and works once. If you were not expecting it, you can close this page.</p>
    </main>
  )
}

function Header({ title, view }: { title: string; view: View }) {
  return (
    <>
      <h1>{title}</h1>
      <p className="pub-sheet">
        in <strong>{view.sheetName}</strong>
      </p>
      {view.message && <p className="pub-message">{view.message}</p>}
    </>
  )
}

interface FormProps<V> {
  view: V
  token: string
  onDone(text: string): void
  onClosed(c: { title: string; text: string }): void
}

function UpdateForm({ view, token, onDone, onClosed }: FormProps<UpdateView>) {
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(view.fields.map((f) => [f.id, f.value ?? (f.type === 'CHECKBOX' ? false : f.type === 'MULTI_PICKLIST' ? [] : '')])))
  const [error, setError] = useState<{ text: string; fieldId?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const errId = useId()

  async function submit(e: FormEvent) {
    e.preventDefault()
    const changed: Record<string, unknown> = {}
    for (const f of view.fields) {
      if (!f.editable) continue
      const initial = f.value ?? (f.type === 'CHECKBOX' ? false : f.type === 'MULTI_PICKLIST' ? [] : '')
      if (JSON.stringify(values[f.id]) !== JSON.stringify(initial)) changed[f.id] = values[f.id]
    }
    if (Object.keys(changed).length === 0) {
      setError({ text: 'Change at least one value, then send.' })
      return
    }
    setBusy(true)
    setError(null)
    const { status, body } = await call('u', token, { body: { values: changed } })
    setBusy(false)
    if (status === 200) return onDone('Your update was sent. You can close this page.')
    if (status === 400) return setError({ text: String(body.error ?? 'Check the values and try again.'), fieldId: typeof body.fieldId === 'string' ? body.fieldId : undefined })
    onClosed(closedFor(status, body))
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <Header title="Please update this row" view={view} />
      <div className="pub-fields">
        {view.fields.map((f) => (
          <FieldInput key={f.id} field={f} value={values[f.id]} invalid={error?.fieldId === f.id} describedBy={error?.fieldId === f.id ? errId : undefined} onChange={(v) => setValues({ ...values, [f.id]: v })} />
        ))}
      </div>
      {error && (
        <p id={errId} role="alert" className="pub-error">
          {error.text}
        </p>
      )}
      <button type="submit" className="btn-primary pub-submit" disabled={busy}>
        {busy ? 'Sending…' : 'Send update'}
      </button>
    </form>
  )
}

function FieldInput({ field: f, value, invalid, describedBy, onChange }: { field: Field; value: unknown; invalid: boolean; describedBy?: string; onChange(v: unknown): void }) {
  const id = useId()
  const common = { id, 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy, disabled: !f.editable }
  if (f.type === 'CHECKBOX') {
    return (
      <div className="pub-field">
        <label className="au-check" htmlFor={id}>
          <input {...common} type="checkbox" checked={value === true} onChange={(e) => onChange(e.currentTarget.checked)} />
          {f.title}
        </label>
      </div>
    )
  }
  if (f.type === 'MULTI_PICKLIST') {
    const list = Array.isArray(value) ? (value as string[]) : []
    return (
      <fieldset className="pub-field" aria-describedby={describedBy}>
        <legend className="label">{f.title}</legend>
        {(f.options ?? []).map((o) => (
          <label key={o} className="au-check">
            <input type="checkbox" disabled={!f.editable} checked={list.includes(o)} onChange={(e) => onChange(e.currentTarget.checked ? [...list, o] : list.filter((x) => x !== o))} />
            {o}
          </label>
        ))}
      </fieldset>
    )
  }
  return (
    <div className="pub-field">
      <label className="label" htmlFor={id}>
        {f.title}
        {!f.editable && <span className="pub-calc"> (calculated, cannot be changed)</span>}
      </label>
      {f.type === 'PICKLIST' ? (
        <select {...common} className="input" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.currentTarget.value)}>
          <option value="">(blank)</option>
          {(f.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input {...common} className="input" type={f.type === 'DATE' ? 'date' : f.type === 'CONTACT_LIST' ? 'email' : 'text'} inputMode={f.type === 'TEXT_NUMBER' ? 'text' : undefined} value={value == null ? '' : String(value)} onChange={(e) => onChange(e.currentTarget.value)} />
      )}
    </div>
  )
}

function ApprovalForm({ view, token, onDone, onClosed }: FormProps<ApprovalView>) {
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'approved' | 'declined' | null>(null)
  const commentId = useId()

  async function decide(decision: 'approved' | 'declined') {
    setBusy(decision)
    setError(null)
    const { status, body } = await call('a', token, { body: { decision, comment } })
    setBusy(null)
    if (status === 200) return onDone(decision === 'approved' ? 'You approved this request.' : 'You declined this request.')
    if (status === 400) return setError(String(body.error ?? 'Check your answer and try again.'))
    onClosed(closedFor(status, body))
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
      }}
    >
      <Header title="Your approval is needed" view={view} />
      {view.shown.length > 0 && (
        <dl className="pub-shown">
          {view.shown.map((s) => (
            <div key={s.title}>
              <dt>{s.title}</dt>
              <dd>{s.value || '—'}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="pub-field">
        <label className="label" htmlFor={commentId}>
          Comment (optional)
        </label>
        <textarea id={commentId} className="input" rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.currentTarget.value)} />
      </div>
      {error && (
        <p role="alert" className="pub-error">
          {error}
        </p>
      )}
      <div className="pub-decide">
        <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => void decide('approved')}>
          {busy === 'approved' ? 'Sending…' : 'Approve'}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void decide('declined')}>
          {busy === 'declined' ? 'Sending…' : 'Decline'}
        </button>
      </div>
      <p className="au-hint">
        Approve records “{view.approveLabel}”; decline records “{view.declineLabel}”.
      </p>
    </form>
  )
}
