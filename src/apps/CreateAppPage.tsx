import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllPages } from '../store/paging'
import { localToday } from '../rm/dates'
import type { Person } from '../rm/types'
import { insertSheetFromTemplate } from '../templates/insertTemplate'
import { buildApp } from './build'
import { APP_TEMPLATES } from './catalog'
import { createApp } from './createApp'
import { Illustration } from './illustrations'
import type { AppTemplate } from './types'
import './apps.css'

export interface CreateAppPageProps {
  client: SupabaseClient
  userId: string
  onBack: () => void
  /** Called with the new app's plan sheet (or a blank sheet) once created. */
  onCreated: (sheetId: string) => void
  today?: string
}

export function CreateAppPage({ client, userId, onBack, onCreated, today = localToday() }: CreateAppPageProps) {
  const [chosen, setChosen] = useState<AppTemplate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [blankBusy, setBlankBusy] = useState(false)

  async function createBlank() {
    setBlankBusy(true)
    setError(null)
    try {
      onCreated(await insertSheetFromTemplate(client, 'project-schedule', userId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBlankBusy(false)
    }
  }

  return (
    <section className="create-app">
      <button type="button" className="create-app-back" onClick={onBack}>
        ← Back
      </button>
      <h1>Create app</h1>
      {error && <p role="alert">{error}</p>}

      <h2>From scratch</h2>
      <p className="create-app-sub">Start with an empty project schedule sheet and build it your way.</p>
      <div className="create-app-cards">
        <button type="button" className="create-app-card is-blank" onClick={() => void createBlank()} disabled={blankBusy} aria-label="Blank project schedule">
          <span className="create-app-plus" aria-hidden="true">
            +
          </span>
          <strong>Blank project schedule</strong>
        </button>
      </div>

      <h2>From template</h2>
      <p className="create-app-sub">
        We set up a phased project plan, supporting sheets and a Resource Management project with the roles it needs.
      </p>
      <ul className="create-app-cards">
        {APP_TEMPLATES.map((t) => (
          <li key={t.id}>
            <button type="button" className="create-app-card" onClick={() => setChosen(t)}>
              <Illustration kind={t.illustration} />
              <strong>{t.name}</strong>
              <small>{t.tagline}</small>
            </button>
          </li>
        ))}
      </ul>

      {chosen && (
        <TemplateDialog
          template={chosen}
          client={client}
          userId={userId}
          today={today}
          onClose={() => setChosen(null)}
          onCreated={onCreated}
        />
      )}
    </section>
  )
}

function TemplateDialog({
  template,
  client,
  userId,
  today,
  onClose,
  onCreated,
}: {
  template: AppTemplate
  client: SupabaseClient
  userId: string
  today: string
  onClose: () => void
  onCreated: (sheetId: string) => void
}) {
  const titleId = useId()
  const nameId = useId()
  const clientId = useId()
  const startId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(template.name)
  const [clientName, setClientName] = useState('')
  const [start, setStart] = useState(today)
  const [withResources, setWithResources] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sheetCount = 1 + template.supportSheets.length

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    nameRef.current?.select()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  function onKeyDown(e: KeyboardEvent) {
    e.stopPropagation()
    if (e.key === 'Escape' && !busy) onClose()
  }

  async function create() {
    if (!name.trim()) return setError('Enter a project name')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return setError('Enter a start date')
    setError(null)
    setBusy('Preparing')
    try {
      let people: Person[] = []
      if (withResources) {
        people = await fetchAllPages<Person>((from, to) => client.from('rm_people').select('*').order('id').range(from, to))
      }
      const app = buildApp(template, { projectName: name.trim(), client: clientName.trim() || null, startDate: start, ownerId: userId, withResources }, people)
      const created = await createApp(client, app, people, setBusy)
      onCreated(created.planSheetId)
    } catch (err) {
      setError(`Could not create the app: ${err instanceof Error ? err.message : String(err)}`)
      setBusy(null)
    }
  }

  return (
    <div className="confirm-backdrop">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="template-dialog" onKeyDown={onKeyDown}>
        <div className="template-dialog-head">
          <h2 id={titleId}>{template.name}</h2>
          <button type="button" className="template-close" aria-label="Close" onClick={onClose} disabled={!!busy}>
            ×
          </button>
        </div>
        <div className="template-dialog-body">
          <Illustration kind={template.illustration} />
          <div>
            <h3>About this app template</h3>
            {template.about.map((p) => (
              <p key={p}>{p}</p>
            ))}
            <p>
              <strong>Roles:</strong> {template.roles.join(', ')}.
            </p>
            <form
              className="template-form"
              onSubmit={(e) => {
                e.preventDefault()
                if (!busy) void create()
              }}
            >
              <label htmlFor={nameId}>Project name</label>
              <input id={nameId} ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} disabled={!!busy} />
              <label htmlFor={clientId}>Client (optional)</label>
              <input id={clientId} value={clientName} onChange={(e) => setClientName(e.target.value)} disabled={!!busy} />
              <label htmlFor={startId}>Start date</label>
              <input id={startId} type="date" value={start} onChange={(e) => setStart(e.target.value)} disabled={!!busy} />
              <label className="template-check">
                <input type="checkbox" checked={withResources} onChange={(e) => setWithResources(e.target.checked)} disabled={!!busy} />
                Set up the project in Resource Management
              </label>
              <div className="template-info" role="note">
                We&apos;ll create {sheetCount} sheets named &quot;{name.trim() || template.name} – …&quot;
                {withResources ? ', a project in Resource Management and a placeholder person for each role' : ''}.
              </div>
              {error && <p role="alert">{error}</p>}
              {busy && (
                <p role="status" className="template-progress">
                  <span className="template-spinner" aria-hidden="true" /> {busy}…
                </p>
              )}
              <div className="template-actions">
                <button type="button" onClick={onClose} disabled={!!busy}>
                  Cancel
                </button>
                <button type="submit" className="template-create" disabled={!!busy}>
                  {busy ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
