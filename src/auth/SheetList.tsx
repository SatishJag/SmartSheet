import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_TEMPLATE_ID, TEMPLATES, type TemplateId } from '../templates'
import { MAX_IMPORT_BYTES, sheetFromCsv, sheetNameFromFile } from '../import/sheetFromCsv'
import { insertSheetData, insertSheetFromTemplate } from '../templates/insertTemplate'
import { fetchAllPages } from '../store/paging'
import { ConfirmDialog } from '../views/ConfirmDialog'
import { InlineRename } from '../views/InlineRename'
import { PlannerWizard } from '../planner/PlannerWizard'
import { Icon, type IconName } from '../ui/Icon'
import './sheetList.css'

interface SheetRow {
  id: string
  name: string
  created_at: string
}

interface SheetListProps {
  client: SupabaseClient
  userId: string
  onOpen: (sheetId: string) => void
}

const TEMPLATE_ICONS: Record<TemplateId, IconName> = {
  'project-schedule': 'gantt',
  'punch-list': 'checklist',
  'simple-list': 'list',
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

export function SheetList({ client, userId, onOpen }: SheetListProps) {
  const [sheets, setSheets] = useState<SheetRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [templateId, setTemplateId] = useState<TemplateId>(DEFAULT_TEMPLATE_ID)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SheetRow | null>(null)
  const [planning, setPlanning] = useState(false)
  const inFlight = useRef(false)
  const active = useRef(true)
  const templateGroupId = useId()
  const aiDescId = useId()
  const importInputId = useId()

  /** Loads the whole list (paged: Supabase returns at most 1000 rows per request). */
  const load = useCallback(async () => {
    try {
      const rows = await fetchAllPages<SheetRow>((from, to) =>
        client.from('sheets').select('id,name,created_at').order('created_at', { ascending: false }).order('id').range(from, to),
      )
      if (active.current) setSheets(rows)
    } catch (err) {
      if (active.current) setError(message(err, 'Could not load sheets'))
    }
  }, [client])

  useEffect(() => {
    active.current = true
    void load()
    return () => {
      active.current = false
    }
  }, [load])

  async function createSheet() {
    if (inFlight.current) return
    inFlight.current = true
    setError(null)
    setCreating(true)
    try {
      // Every new sheet starts from a template, so it always has columns to work with.
      onOpen(await insertSheetFromTemplate(client, templateId, userId))
    } catch (err) {
      setError(message(err, 'Could not create the sheet'))
    } finally {
      inFlight.current = false
      setCreating(false)
    }
  }

  /** Creates a new sheet from the chosen CSV file and opens it. */
  async function importCsv(file: File | undefined) {
    if (!file || inFlight.current) return
    inFlight.current = true
    setError(null)
    setCreating(true)
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error(`"${file.name}" is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB`)
      const data = sheetFromCsv(await file.text(), sheetNameFromFile(file.name), userId)
      onOpen(await insertSheetData(client, data))
    } catch (err) {
      setError(`Could not import "${file.name}": ${message(err, 'unknown error')}`)
    } finally {
      inFlight.current = false
      setCreating(false)
    }
  }

  /** Saves a new name; resolves to an error message or null. */
  async function rename(id: string, name: string): Promise<string | null> {
    const { error: err } = await client.from('sheets').update({ name }).eq('id', id)
    if (err) return err.message
    setSheets((list) => list?.map((s) => (s.id === id ? { ...s, name } : s)) ?? list)
    setRenamingId(null)
    return null
  }

  async function confirmDelete(sheet: SheetRow) {
    setDeleting(null)
    setError(null)
    // Deleting the sheet row cascades to its columns, rows and dependencies in the database.
    const { error: err } = await client.from('sheets').delete().eq('id', sheet.id)
    if (err) setError(`Could not delete "${sheet.name}": ${err.message}`)
    await load()
  }

  return (
    <section className="sheet-list">
      {deleting && (
        <ConfirmDialog
          title="Delete sheet"
          message={`Delete "${deleting.name}" and all of its rows? This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={() => void confirmDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
      <div className="page-intro">
        <h2>Your sheets</h2>
        <p>Schedules, punch lists and trackers for your projects, all in one place.</p>
      </div>

      <div className="create-panel">
        <div className="create-templates">
          <h3 id={templateGroupId}>Template</h3>
          <div role="radiogroup" aria-labelledby={templateGroupId} className="template-grid">
            {TEMPLATES.map((t) => (
              <label key={t.id} className={`template-card lift${t.id === templateId ? ' is-selected' : ''}`}>
                <input
                  type="radio"
                  name="sheet-template"
                  value={t.id}
                  checked={t.id === templateId}
                  disabled={creating}
                  aria-labelledby={`${templateGroupId}-${t.id}-name`}
                  aria-describedby={`${templateGroupId}-${t.id}-desc`}
                  onChange={() => setTemplateId(t.id)}
                />
                <span className="template-icon pop-icon">
                  <Icon name={TEMPLATE_ICONS[t.id]} size={22} />
                </span>
                <span className="template-text">
                  <span id={`${templateGroupId}-${t.id}-name`} className="template-name">
                    {t.name}
                  </span>
                  <span id={`${templateGroupId}-${t.id}-desc`} className="template-desc">
                    {t.description}
                  </span>
                </span>
                <span className="template-check" aria-hidden="true">
                  <Icon name="check" size={14} strokeWidth={3} />
                </span>
              </label>
            ))}
          </div>
          <div className="create-actions">
            <button type="button" className="btn btn-primary" onClick={createSheet} disabled={creating}>
              <Icon name="plus" size={18} />
              New sheet
            </button>
            <label htmlFor={importInputId} className={`btn btn-ghost${creating ? ' is-disabled' : ''}`}>
              Import CSV
            </label>
            <input
              id={importInputId}
              className="visually-hidden"
              type="file"
              accept=".csv,text/csv"
              disabled={creating}
              onChange={(e) => {
                void importCsv(e.target.files?.[0])
                e.target.value = '' // lets the same file be chosen again after a failure
              }}
            />
            <span className="create-hint">Creates a sheet from the selected template, or from a CSV file.</span>
          </div>
        </div>
        <button
          type="button"
          className="ai-card lift"
          aria-label="Plan with AI"
          aria-describedby={aiDescId}
          onClick={() => setPlanning(true)}
          disabled={creating}
        >
          <span className="ai-icon pop-icon">
            <Icon name="sparkles" size={24} />
          </span>
          <span className="ai-title" aria-hidden="true">
            Plan with AI
          </span>
          <span id={aiDescId} className="ai-desc">
            Describe your project and get a phased, dependency-linked schedule you can edit.
          </span>
          <span className="ai-go" aria-hidden="true">
            Start planning <Icon name="arrow" size={16} />
          </span>
        </button>
      </div>

      {planning && (
        <PlannerWizard
          client={client}
          userId={userId}
          onClose={() => setPlanning(false)}
          onCreated={(sheetId) => {
            setPlanning(false)
            onOpen(sheetId)
          }}
        />
      )}
      {error && <p role="alert" className="list-error">{error}</p>}
      {sheets === null && !error && (
        <div className="sheet-grid" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="sheet-card skeleton-card">
              <span className="skeleton skeleton-icon" />
              <span className="skeleton skeleton-line" />
              <span className="skeleton skeleton-line is-short" />
            </div>
          ))}
        </div>
      )}
      {sheets === null && !error && <p className="visually-hidden">Loading sheets...</p>}
      {sheets !== null && sheets.length === 0 && (
        <div className="empty-state">
          <span className="empty-icon">
            <Icon name="sheet" size={28} />
          </span>
          <p className="empty-title">No sheets yet</p>
          <p className="empty-text">Pick a template above and choose New sheet, or let AI draft a schedule for you.</p>
        </div>
      )}
      {sheets !== null && sheets.length > 0 && (
        <>
          <h3 className="list-heading">
            Recent <span className="chip">{sheets.length}</span>
          </h3>
          <ul className="sheet-grid">
            {sheets.map((sheet) => (
              <li key={sheet.id} className="sheet-card card lift">
                {renamingId === sheet.id ? (
                  <div className="sheet-card-rename">
                    <InlineRename
                      initial={sheet.name}
                      onSave={(name) => rename(sheet.id, name)}
                      onCancel={() => setRenamingId(null)}
                    />
                  </div>
                ) : (
                  <button type="button" className="sheet-item" onClick={() => onOpen(sheet.id)}>
                    <span className="sheet-icon pop-icon">
                      <Icon name="sheet" size={22} />
                    </span>
                    <span className="sheet-name">{sheet.name}</span>
                    <small className="sheet-date">Created {formatDate(sheet.created_at)}</small>
                  </button>
                )}
                <div className="sheet-actions">
                  <button
                    type="button"
                    className="btn-icon"
                    aria-label={`Rename ${sheet.name}`}
                    title="Rename"
                    onClick={() => setRenamingId(sheet.id)}
                  >
                    <Icon name="pencil" size={17} />
                  </button>
                  <button
                    type="button"
                    className="btn-icon is-danger"
                    aria-label={`Delete ${sheet.name}`}
                    title="Delete"
                    onClick={() => setDeleting(sheet)}
                  >
                    <Icon name="trash" size={17} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
