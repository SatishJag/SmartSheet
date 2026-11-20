import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Column } from '../../model/validate'
import { useShell } from '../../shell/ShellContext'
import { ConfirmDialog } from '../../views/ConfirmDialog'
import { defaultSettings, whatsappApi, type WaContact, type WaMessage, type WaSettings, type WaStatus, type WhatsAppApi } from '../api'
import { maskPhone, normalizePhone } from '../phone'
import { findColumns } from '../tasks'
import '../../automation/automation.css'
import './whatsapp.css'

type Tab = 'phone' | 'alerts' | 'contacts' | 'messages'
const TABS: { id: Tab; label: string }[] = [
  { id: 'phone', label: 'My phone' },
  { id: 'alerts', label: 'Sheet alerts' },
  { id: 'contacts', label: 'Site contacts' },
  { id: 'messages', label: 'Messages' },
]

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** WhatsApp: link your phone, turn on alerts per sheet, invite site contacts, see what was sent. */
export function WhatsAppPage() {
  const { client, userId } = useShell()
  const api = useMemo(() => whatsappApi(client), [client])
  const [tab, setTab] = useState<Tab>('phone')
  // undefined: loading; null: the server could not be reached
  const [status, setStatus] = useState<WaStatus | null | undefined>(undefined)
  const [statusError, setStatusError] = useState<string | null>(null)

  const refreshStatus = useCallback(async () => {
    const res = await api.status()
    if (res.ok) {
      setStatus(res.data)
      setStatusError(null)
    } else {
      setStatus(null)
      setStatusError(res.error)
    }
    return res.ok ? res.data : null
  }, [api])
  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const note =
    status === undefined
      ? null
      : status === null
        ? `The planning server could not be reached (${statusError ?? 'no answer'}). Settings and contacts can still be edited; linking, test messages and alerts need the server.`
        : !status.enabled
          ? (status.reason ?? 'WhatsApp is off on this server.')
          : status.mode === 'simulator'
            ? 'Simulator mode: no WhatsApp account is connected to this server, so nothing is really sent. Use the test chat under My phone to play the phone; every message also appears under Messages.'
            : null

  return (
    <div className="au-page wa-page">
      <header className="au-page-head">
        <div>
          <h1>WhatsApp</h1>
          <p className="au-sub">Delay alerts, progress checks, a daily summary and a project menu on WhatsApp, for you and the people doing the work on site.</p>
        </div>
      </header>
      {note && (
        <p className="au-note" role="note">
          {note}
        </p>
      )}
      <div className="au-tabbar">
        <div role="tablist" aria-label="WhatsApp" className="segmented">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'is-active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {tab === 'phone' && <PhoneTab api={api} status={status} refreshStatus={refreshStatus} />}
      {tab === 'alerts' && <AlertsTab api={api} status={status} userId={userId} />}
      {tab === 'contacts' && <ContactsTab api={api} status={status} />}
      {tab === 'messages' && <MessagesTab api={api} />}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------

function PhoneTab({ api, status, refreshStatus }: { api: WhatsAppApi; status: WaStatus | null | undefined; refreshStatus(): Promise<WaStatus | null> }) {
  const [code, setCode] = useState<{ code: string; text: string; waLink: string | null; expiresAt: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmUnlink, setConfirmUnlink] = useState(false)
  const linked = status?.linked ?? null

  // While a code is showing, look every few seconds whether the phone has sent it.
  useEffect(() => {
    if (!code || linked) return
    const t = setInterval(() => void refreshStatus(), 4000)
    return () => clearInterval(t)
  }, [code, linked, refreshStatus])
  useEffect(() => {
    if (linked) setCode(null)
  }, [linked])

  async function getCode() {
    setBusy(true)
    setError(null)
    const res = await api.linkCode()
    setBusy(false)
    if (res.ok) setCode(res.data)
    else setError(res.error)
  }

  async function unlink() {
    setConfirmUnlink(false)
    const res = await api.unlink()
    if (!res.ok) setError(res.error)
    await refreshStatus()
  }

  const disabled = !status?.enabled
  return (
    <div className="wa-grid">
      <section className="card wa-card" aria-labelledby="wa-phone-h">
        <h2 id="wa-phone-h">Your phone</h2>
        {status === undefined ? (
          <p className="au-hint">Loading…</p>
        ) : linked ? (
          <>
            <p className="wa-linked">
              <span className="au-badge is-done">Linked</span> {linked.masked}
            </p>
            <p className="wa-muted">Send <b>MENU</b> to the planner’s WhatsApp number to pick a project, or ask a question about it in your own words. Send <b>STOP</b> to stop all messages.</p>
            <div className="au-actions">
              <button type="button" className="btn-sm" onClick={() => setConfirmUnlink(true)}>
                Unlink this phone
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="wa-muted">Link the phone you use on site. You will get alerts and summaries for the sheets you turn on, and can check and update tasks by replying.</p>
            {!code ? (
              <div className="au-actions">
                <button type="button" className="btn-primary" disabled={disabled || busy} onClick={() => void getCode()}>
                  {busy ? 'Getting a code…' : 'Link my phone'}
                </button>
              </div>
            ) : (
              <div className="wa-code" aria-live="polite">
                <p>
                  Send this message from your phone{status?.businessNumber ? <> to <b>+{status.businessNumber}</b></> : null}:
                </p>
                <p className="wa-code-text">{code.text}</p>
                <div className="au-actions">
                  {code.waLink && (
                    <a className="btn btn-primary" href={code.waLink} target="_blank" rel="noreferrer">
                      Open WhatsApp
                    </a>
                  )}
                  <button type="button" className="btn-sm" onClick={() => void getCode()}>
                    New code
                  </button>
                </div>
                <p className="au-hint">
                  The code works once, until {when(code.expiresAt)}. This page updates when your phone is linked.
                  {status?.mode === 'simulator' ? ' In simulator mode, send it from the test chat below with your number.' : ''}
                </p>
              </div>
            )}
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </section>

      <section className="card wa-card" aria-labelledby="wa-what-h">
        <h2 id="wa-what-h">What you can send</h2>
        <ul className="wa-help">
          <li><b>MENU</b> pick a project (yours, or one shared with you), then <b>1</b> delayed · <b>2</b> due in 30 days · <b>3</b> at risk / on track · <b>4</b> critical path · <b>5</b> milestones · <b>6</b> remind task owners · <b>7</b> summary</li>
          <li><b>#3</b> details of item 3 in the last list</li>
          <li><b>3 Complete</b>, <b>3 60%</b>, <b>3 In progress - waiting for steel</b> update item 3</li>
          <li><b>EMAIL</b> the full last list to your e-mail</li>
          <li>Any question, e.g. <i>what is late on the MEP works?</i>{status && !status.ai ? ' (needs an AI key on the server)' : ''}</li>
        </ul>
      </section>

      {status?.mode === 'simulator' && status.enabled && <TestChat api={api} status={status} onLinked={refreshStatus} />}

      {confirmUnlink && (
        <ConfirmDialog
          title="Unlink this phone?"
          message="You will stop getting WhatsApp alerts and summaries, and this phone can no longer read or update your sheets."
          confirmLabel="Unlink"
          onConfirm={() => void unlink()}
          onCancel={() => setConfirmUnlink(false)}
        />
      )}
    </div>
  )
}

interface ChatLine {
  from: 'me' | 'bot'
  text: string
  status?: string
}

function TestChat({ api, status, onLinked }: { api: WhatsAppApi; status: WaStatus; onLinked(): Promise<unknown> }) {
  const [phone, setPhone] = useState(status.linked?.phone ?? '')
  const [text, setText] = useState('')
  const [lines, setLines] = useState<ChatLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (status.linked) setPhone(status.linked.phone)
  }, [status.linked])
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [lines])

  async function send(e: React.FormEvent) {
    e.preventDefault()
    const msg = text.trim()
    if (!msg) return
    const p = normalizePhone(phone)
    if (!p) {
      setError('Enter the phone number to send from, with the country code (e.g. +971 50 123 4567).')
      return
    }
    setBusy(true)
    setError(null)
    setLines((l) => [...l, { from: 'me', text: msg }])
    setText('')
    const res = await api.simulate(msg, p)
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setLines((l) => [...l, ...res.data.replies.map((r) => ({ from: 'bot' as const, text: r.body, status: r.status }))])
    if (/^link\s/i.test(msg)) void onLinked()
  }

  return (
    <section className="card wa-card wa-chat-card" aria-labelledby="wa-chat-h">
      <h2 id="wa-chat-h">Test chat</h2>
      <p className="wa-muted">Plays a phone against the assistant. Use your own number, or a site contact’s number to see what they see.</p>
      <div className="au-field wa-chat-phone">
        <label className="label" htmlFor="wa-chat-phone">
          Phone number
        </label>
        <input id="wa-chat-phone" className="input" inputMode="tel" value={phone} placeholder="+971 50 123 4567" onChange={(e) => setPhone(e.currentTarget.value)} />
      </div>
      <div className="wa-chat" role="log" aria-label="Test chat" aria-live="polite">
        {lines.length === 0 && <p className="wa-chat-empty">Send <b>MENU</b> to start{status.linked ? '' : ', or the LINK code from above'}.</p>}
        {lines.map((l, i) => (
          <div key={i} className={l.from === 'me' ? 'wa-bubble is-me' : 'wa-bubble'}>
            <WaText text={l.text} />
            {l.status && l.status !== 'simulated' && l.status !== 'sent' && <span className="wa-bubble-status">{l.status}</span>}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form className="wa-chat-form" onSubmit={(e) => void send(e)}>
        <label className="visually-hidden" htmlFor="wa-chat-text">
          Message
        </label>
        <input id="wa-chat-text" className="input" value={text} autoComplete="off" placeholder="Type a message" onChange={(e) => setText(e.currentTarget.value)} />
        <button type="submit" className="btn-primary" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

/** WhatsApp formatting: *bold* and _italic_, line breaks kept. */
export function WaText({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_)/g)
  return (
    <span className="wa-text">
      {parts.map((p, i) =>
        /^\*[^*\n]+\*$/.test(p) ? <b key={i}>{p.slice(1, -1)}</b> : /^_[^_\n]+_$/.test(p) ? <i key={i}>{p.slice(1, -1)}</i> : <span key={i}>{p}</span>,
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------------------------------

const HOURS = Array.from({ length: 24 }, (_, h) => h)
function timeZones(current: string): string[] {
  let all: string[] = []
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {
    all = []
  }
  const list = all.length ? all : ['UTC', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Kolkata', 'Asia/Singapore', 'Europe/London', 'America/New_York']
  return list.includes(current) ? list : [current, ...list]
}

function AlertsTab({ api, status, userId }: { api: WhatsAppApi; status: WaStatus | null | undefined; userId: string }) {
  const [sheets, setSheets] = useState<{ id: string; name: string }[] | null>(null)
  const [sharedCount, setSharedCount] = useState(0)
  const [sheetId, setSheetId] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.listSheets().then(
      (list) => {
        // Alerts are the owner's to set (the database refuses anyone else); shared sheets work in WhatsApp all the same.
        const own = list.filter((s) => s.owner_id === userId)
        setSheets(own)
        setSharedCount(list.length - own.length)
        setSheetId(own[0]?.id ?? '')
      },
      (e: unknown) => setError(errorText(e, 'Could not load your sheets')),
    )
  }, [api, userId])
  const sharedNote =
    sharedCount > 0 ? (
      <p className="au-hint">
        {sharedCount === 1 ? '1 sheet is' : `${sharedCount} sheets are`} shared with you: their owners set their alerts. You can still open them from WhatsApp (MENU), and update their tasks where you are an editor.
      </p>
    ) : null
  if (error) return <p role="alert">{error}</p>
  if (!sheets) return <p className="au-hint">Loading…</p>
  if (sheets.length === 0)
    return (
      <div className="card au-empty">
        <h2>{sharedCount > 0 ? 'No sheets of your own yet' : 'No sheets yet'}</h2>
        <p>Alerts belong to a sheet and are set by its owner. Create a sheet first, then come back.</p>
        {sharedNote}
      </div>
    )
  return (
    <>
      <div className="au-sheet-pick">
        <label className="label" htmlFor="wa-sheet">
          Sheet
        </label>
        <select id="wa-sheet" className="input" value={sheetId} onChange={(e) => setSheetId(e.currentTarget.value)}>
          {sheets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      {sharedNote}
      <SheetAlerts key={sheetId} api={api} sheetId={sheetId} status={status} />
    </>
  )
}

function SheetAlerts({ api, sheetId, status }: { api: WhatsAppApi; sheetId: string; status: WaStatus | null | undefined }) {
  const [columns, setColumns] = useState<Column[] | null>(null)
  const [form, setForm] = useState<WaSettings | null>(null)
  const [saved, setSaved] = useState<WaSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    Promise.all([api.listColumns(sheetId), api.getSettings(sheetId)]).then(
      ([cols, s]) => {
        if (!live) return
        setColumns(cols)
        setSaved(s)
        setForm(s ?? { ...defaultSettings(sheetId), enabled: false })
      },
      (e: unknown) => live && setError(errorText(e, 'Could not load the settings. If this is a new installation, migration 0015 may not be applied yet.')),
    )
    return () => {
      live = false
    }
  }, [api, sheetId])

  if (error) return <p role="alert">{error}</p>
  if (!columns || !form) return <p className="au-hint">Loading…</p>

  const contacts = columns.filter((c) => c.type === 'CONTACT_LIST')
  const detected = findColumns(columns, form.ownerColumnId)
  const set = (patch: Partial<WaSettings>) => {
    setForm({ ...form, ...patch })
    setMessage(null)
  }
  const dirty = JSON.stringify(form) !== JSON.stringify(saved)
  const serverOk = status?.enabled === true

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await api.saveSettings(form!)
      setSaved(form)
      setMessage('Saved.')
    } catch (e) {
      setError(errorText(e, 'Could not save'))
    } finally {
      setBusy(false)
    }
  }

  async function run(kind: 'summary' | 'check') {
    setBusy(true)
    setMessage(null)
    const res = kind === 'summary' ? await api.summaryNow(sheetId) : await api.checkNow(sheetId)
    setBusy(false)
    if (!res.ok) setMessage(res.error)
    else if (kind === 'summary') setMessage((res.data as { ok: boolean }).ok ? 'Summary sent to your phone.' : 'Nothing was sent: link your phone first.')
    else {
      const r = res.data as { alerts: number; nudges: number; summary: boolean }
      setMessage(`Checked: ${r.alerts} delay alert(s) and ${r.nudges} progress check(s) queued${r.summary ? ', and today’s summary' : ''}. Messages already sent are not repeated.`)
    }
  }

  return (
    <section className="card wa-settings" aria-label="WhatsApp alerts for this sheet">
      <label className="switch wa-master">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.currentTarget.checked })} />
        <span className="switch-track" aria-hidden="true" />
        <span>
          <b>WhatsApp for this sheet</b>
          <span className="wa-muted wa-block">Alerts and summaries go out, and site contacts can see and update their tasks in it.</span>
        </span>
      </label>

      <fieldset className="wa-fields" disabled={!form.enabled}>
        <legend className="visually-hidden">Alert settings</legend>
        <div className="au-field">
          <label className="label" htmlFor="wa-owner-col">
            Task owner column
          </label>
          {contacts.length === 0 ? (
            <p className="wa-warn" role="note">
              This sheet has no Contact column. Add one (for example “Responsible”) with each task owner’s e-mail, so alerts and progress checks reach the people doing the work. Until then only you get the summary and critical delays.
            </p>
          ) : (
            <select id="wa-owner-col" className="input" value={form.ownerColumnId ?? ''} onChange={(e) => set({ ownerColumnId: e.currentTarget.value || null })}>
              <option value="">Automatic ({columns.find((c) => c.id === detected.owner)?.title ?? 'none'})</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="wa-option">
          <label className="au-check">
            <input type="checkbox" checked={form.delayAlerts} onChange={(e) => set({ delayAlerts: e.currentTarget.checked })} />
            <b>Delay alerts</b>
          </label>
          <p className="wa-muted">When a task passes its finish date and is not complete, its owners are told once and can reply 1 On track · 2 Delayed · 3 Complete · 4 Blocked. Late critical-path tasks with no owner on WhatsApp come to you.</p>
        </div>

        <div className="wa-option">
          <label className="au-check">
            <input type="checkbox" checked={form.nudges} onChange={(e) => set({ nudges: e.currentTarget.checked })} />
            <b>Progress checks</b>
          </label>
          <p className="wa-muted">At 50%, 70% and 90% of a task’s planned time, when its % complete is behind, its owners are asked how it is going.</p>
          <div className="au-grid">
            <div className="au-field">
              <label className="label" htmlFor="wa-rem-h">
                Remind after (hours)
              </label>
              <input id="wa-rem-h" className="input" type="number" min={1} max={168} value={form.reminderHours} disabled={!form.nudges} onChange={(e) => set({ reminderHours: clamp(e.currentTarget.valueAsNumber, 1, 168, 24) })} />
            </div>
            <div className="au-field">
              <label className="label" htmlFor="wa-rem-n">
                Reminders before telling you
              </label>
              <input id="wa-rem-n" className="input" type="number" min={0} max={10} value={form.maxReminders} disabled={!form.nudges} onChange={(e) => set({ maxReminders: clamp(e.currentTarget.valueAsNumber, 0, 10, 2) })} />
            </div>
          </div>
        </div>

        <div className="wa-option">
          <label className="au-check">
            <input type="checkbox" checked={form.dailySummary} onChange={(e) => set({ dailySummary: e.currentTarget.checked })} />
            <b>Daily summary to me</b>
          </label>
          <div className="au-grid">
            <div className="au-field">
              <label className="label" htmlFor="wa-hour">
                Send at
              </label>
              <select id="wa-hour" className="input" value={form.summaryHour} disabled={!form.dailySummary} onChange={(e) => set({ summaryHour: Number(e.currentTarget.value) })}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
            </div>
            <div className="au-field">
              <label className="label" htmlFor="wa-tz">
                Time zone
              </label>
              <select id="wa-tz" className="input" value={form.timeZone} onChange={(e) => set({ timeZone: e.currentTarget.value })}>
                {timeZones(form.timeZone).map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="wa-option">
          <b>Quiet hours</b>
          <p className="wa-muted">Routine messages wait until the morning. Critical-path alerts still go out.</p>
          <div className="au-grid">
            <div className="au-field">
              <label className="label" htmlFor="wa-dnd-s">
                From
              </label>
              <input id="wa-dnd-s" className="input" type="time" value={form.dndStart} onChange={(e) => set({ dndStart: e.currentTarget.value || '22:00' })} />
            </div>
            <div className="au-field">
              <label className="label" htmlFor="wa-dnd-e">
                Until
              </label>
              <input id="wa-dnd-e" className="input" type="time" value={form.dndEnd} onChange={(e) => set({ dndEnd: e.currentTarget.value || '07:00' })} />
            </div>
          </div>
        </div>
      </fieldset>

      <div className="au-actions wa-save">
        <button type="button" className="btn-primary" disabled={busy || !dirty} onClick={() => void save()}>
          {saved ? 'Save changes' : 'Save'}
        </button>
        <button type="button" className="btn-sm" disabled={busy || !serverOk || !saved?.enabled || dirty} onClick={() => void run('check')}>
          Check alerts now
        </button>
        <button type="button" className="btn-sm" disabled={busy || !serverOk || !status?.linked} onClick={() => void run('summary')}>
          Send me the summary now
        </button>
      </div>
      {!status?.linked && serverOk && <p className="au-hint">Link your phone (My phone) to get the summary and alerts yourself.</p>}
      {message && <p role="status">{message}</p>}
    </section>
  )
}

const clamp = (n: number, lo: number, hi: number, d: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d)

// ---------------------------------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function ContactsTab({ api, status }: { api: WhatsAppApi; status: WaStatus | null | undefined }) {
  const [contacts, setContacts] = useState<WaContact[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState({ name: '', email: '', phone: '' })
  const [formError, setFormError] = useState<string | null>(null)
  const [invite, setInvite] = useState<{ contact: WaContact; message: string; waLink: string | null; shareLink: string } | null>(null)
  const [removing, setRemoving] = useState<WaContact | null>(null)
  const [copied, setCopied] = useState(false)

  const reload = useCallback(async () => {
    try {
      setContacts(await api.listContacts())
    } catch (e) {
      setError(errorText(e, 'Could not load contacts'))
    }
  }, [api])
  useEffect(() => {
    void reload()
  }, [reload])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const phone = normalizePhone(draft.phone)
    if (!draft.name.trim()) return setFormError('Enter a name.')
    if (!EMAIL_RE.test(draft.email.trim())) return setFormError('Enter the e-mail address used for this person in your sheets’ Contact columns.')
    if (!phone) return setFormError('Enter the WhatsApp number with the country code, e.g. +971 50 123 4567.')
    setFormError(null)
    try {
      await api.addContact({ ...draft, phone })
      setDraft({ name: '', email: '', phone: '' })
      await reload()
    } catch (err) {
      const msg = errorText(err, 'Could not add the contact')
      setFormError(/duplicate|unique/i.test(msg) ? 'You already have a contact with this e-mail or phone.' : msg)
    }
  }

  async function makeInvite(c: WaContact) {
    setCopied(false)
    const res = await api.invite(c.id)
    if (!res.ok) return setError(res.error)
    setInvite({ contact: c, message: res.data.message, waLink: res.data.waLink, shareLink: `https://wa.me/${c.phone}?text=${encodeURIComponent(res.data.message)}` })
  }

  async function remove(c: WaContact) {
    setRemoving(null)
    try {
      await api.deleteContact(c.id)
      await reload()
    } catch (e) {
      setError(errorText(e, 'Could not remove the contact'))
    }
  }

  return (
    <div className="wa-grid">
      <section className="card wa-card" aria-labelledby="wa-add-h">
        <h2 id="wa-add-h">Add a site contact</h2>
        <p className="wa-muted">Subcontractors and foremen who don’t use the planner. They get alerts and progress checks for tasks where their e-mail is in the task owner column, and can update only those tasks. They must accept your invitation from their phone first.</p>
        <form className="wa-contact-form" onSubmit={(e) => void add(e)} noValidate>
          <div className="au-field">
            <label className="label" htmlFor="wa-c-name">
              Name
            </label>
            <input id="wa-c-name" className="input" value={draft.name} maxLength={100} placeholder="Ravi (MEP)" onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })} />
          </div>
          <div className="au-field">
            <label className="label" htmlFor="wa-c-email">
              E-mail in your sheets
            </label>
            <input id="wa-c-email" className="input" type="email" value={draft.email} placeholder="ravi@subcontractor.com" onChange={(e) => setDraft({ ...draft, email: e.currentTarget.value })} />
          </div>
          <div className="au-field">
            <label className="label" htmlFor="wa-c-phone">
              WhatsApp number
            </label>
            <input id="wa-c-phone" className="input" inputMode="tel" value={draft.phone} placeholder="+971 50 123 4567" onChange={(e) => setDraft({ ...draft, phone: e.currentTarget.value })} />
          </div>
          <div className="au-actions">
            <button type="submit" className="btn-primary">
              Add contact
            </button>
          </div>
          {formError && <p role="alert">{formError}</p>}
        </form>
      </section>

      <section className="card wa-card" aria-labelledby="wa-list-h">
        <h2 id="wa-list-h">Contacts</h2>
        {error && <p role="alert">{error}</p>}
        {!contacts ? (
          <p className="au-hint">Loading…</p>
        ) : contacts.length === 0 ? (
          <p className="wa-muted">No site contacts yet.</p>
        ) : (
          <ul className="wa-contacts">
            {contacts.map((c) => (
              <li key={c.id} className="wa-contact">
                <div className="wa-contact-main">
                  <b>{c.name}</b> <span className={c.status === 'active' ? 'au-badge is-done' : 'au-badge is-pending'}>{c.status === 'active' ? 'Joined' : 'Invited'}</span>
                  <span className="wa-muted wa-block">
                    {c.email} · {maskPhone(c.phone)}
                  </span>
                </div>
                <div className="au-rule-actions">
                  <button type="button" className="btn-sm" disabled={!status?.enabled} onClick={() => void makeInvite(c)} aria-label={`Invitation for ${c.name}`}>
                    {c.status === 'active' ? 'New invitation' : 'Invitation'}
                  </button>
                  <button type="button" className="btn-sm" onClick={() => setRemoving(c)} aria-label={`Remove ${c.name}`}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {invite && (
        <section className="card wa-card wa-invite" aria-labelledby="wa-inv-h">
          <h2 id="wa-inv-h">Invitation for {invite.contact.name}</h2>
          <p className="wa-muted">Send this to {invite.contact.name} (it works for 14 days, from {maskPhone(invite.contact.phone)} only):</p>
          <pre className="wa-invite-text">{invite.message}</pre>
          <div className="au-actions">
            <a className="btn btn-primary" href={invite.shareLink} target="_blank" rel="noreferrer">
              Send from my WhatsApp
            </a>
            <button
              type="button"
              className="btn-sm"
              onClick={() => {
                void navigator.clipboard?.writeText(invite.message).then(() => setCopied(true), () => setCopied(false))
              }}
            >
              {copied ? 'Copied' : 'Copy text'}
            </button>
            <button type="button" className="btn-sm" onClick={() => setInvite(null)}>
              Close
            </button>
          </div>
          {status?.mode === 'simulator' && <p className="au-hint">Simulator mode: in the test chat (My phone), use {invite.contact.name}’s number and send the JOIN text.</p>}
        </section>
      )}

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          message="They will stop getting WhatsApp messages about your sheets and can no longer update tasks."
          confirmLabel="Remove"
          onConfirm={() => void remove(removing)}
          onCancel={() => setRemoving(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------

const STATUS_CLASS: Record<string, string> = { sent: 'is-done', simulated: 'is-done', received: 'is-done', pending: 'is-pending', skipped: 'is-skipped', failed: 'is-error' }
const KIND_LABEL: Record<string, string> = { reply: 'Reply', alert: 'Alert', nudge: 'Progress check', summary: 'Summary', rule: 'Rule', system: 'System' }

function MessagesTab({ api }: { api: WhatsAppApi }) {
  const [messages, setMessages] = useState<WaMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    try {
      setMessages(await api.listMessages(150))
      setError(null)
    } catch (e) {
      setError(errorText(e, 'Could not load messages'))
    }
  }, [api])
  useEffect(() => {
    void reload()
  }, [reload])

  return (
    <section aria-label="Messages">
      <div className="au-tabbar">
        <p className="wa-muted">Everything sent and received for your account, newest first.</p>
        <span className="spacer" />
        <button type="button" className="btn-sm" onClick={() => void reload()}>
          Refresh
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!messages ? (
        <p className="au-hint">Loading…</p>
      ) : messages.length === 0 ? (
        <div className="card au-empty">
          <h2>No messages yet</h2>
          <p>Link your phone or turn on alerts for a sheet; messages will show here.</p>
        </div>
      ) : (
        <ul className="au-runs">
          {messages.map((m) => (
            <li key={m.id} className="card au-run wa-msg">
              <span className={`au-badge ${STATUS_CLASS[m.status] ?? ''}`}>{m.direction === 'in' ? 'Received' : m.status}</span>
              <div className="au-run-main">
                <div className="au-run-row">
                  {m.direction === 'in' ? 'From' : 'To'} {maskPhone(m.phone)} · {KIND_LABEL[m.kind] ?? m.kind}
                  {m.priority === 'HIGH' && m.direction === 'out' && m.kind !== 'reply' ? ' · high priority' : ''}
                </div>
                <div className="wa-msg-body">
                  <WaText text={m.body} />
                </div>
                {m.error && <div className="au-run-detail">{m.error}</div>}
              </div>
              <span className="au-run-when">{when(m.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
