import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_TEMPLATE_ID, TEMPLATES, type TemplateId } from '../templates'
import { MAX_IMPORT_BYTES, sheetFromCsv, sheetNameFromFile } from '../import/sheetFromCsv'
import { insertSheetData, insertSheetFromTemplate } from '../templates/insertTemplate'
import { fetchAllPages } from '../store/paging'
import { ConfirmDialog } from '../views/ConfirmDialog'
import { InlineRename } from '../views/InlineRename'

interface SheetRow {
  id: string
  name: string
  created_at: string
  owner_id: string
}

interface SheetListProps {
  client: SupabaseClient
  userId: string
  onOpen: (sheetId: string) => void
}

const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

export function SheetList({ client, userId, onOpen }: SheetListProps) {
  const [sheets, setSheets] = useState<SheetRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [templateId, setTemplateId] = useState<TemplateId>(DEFAULT_TEMPLATE_ID)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SheetRow | null>(null)
  const inFlight = useRef(false)
  const active = useRef(true)
  const templateSelectId = useId()
  const importInputId = useId()

  /** Loads the whole list (paged: Supabase returns at most 1000 rows per request). */
  const load = useCallback(async () => {
    try {
      const rows = await fetchAllPages<SheetRow>((from, to) =>
        client.from('sheets').select('id,name,created_at,owner_id').order('created_at', { ascending: false }).order('id').range(from, to),
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
      <div className="sheet-list-header">
        <h2>Your sheets</h2>
        <div className="sheet-list-new">
          <label htmlFor={templateSelectId}>Template</label>
          <select
            id={templateSelectId}
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value as TemplateId)}
            disabled={creating}
          >
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id} title={t.description}>
                {t.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={createSheet} disabled={creating}>
            New sheet
          </button>
          <label htmlFor={importInputId}>Import CSV</label>
          <input
            id={importInputId}
            type="file"
            accept=".csv,text/csv"
            disabled={creating}
            onChange={(e) => {
              void importCsv(e.target.files?.[0])
              e.target.value = '' // lets the same file be chosen again after a failure
            }}
          />
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {sheets === null && !error && <p>Loading sheets...</p>}
      {sheets !== null && sheets.length === 0 && <p>No sheets yet</p>}
      {sheets !== null && sheets.length > 0 && (
        <ul>
          {sheets.map((sheet) => (
            <li key={sheet.id} className="sheet-list-row">
              {renamingId === sheet.id ? (
                <InlineRename
                  initial={sheet.name}
                  onSave={(name) => rename(sheet.id, name)}
                  onCancel={() => setRenamingId(null)}
                />
              ) : (
                <button type="button" className="sheet-item" onClick={() => onOpen(sheet.id)}>
                  <span>{sheet.name}</span>
                  <small>
                    {sheet.owner_id !== userId && 'Shared with you · '}
                    {new Date(sheet.created_at).toLocaleDateString()}
                  </small>
                </button>
              )}
              {/* Only the owner can rename or delete a sheet. */}
              {sheet.owner_id === userId && (
                <>
                  <button type="button" aria-label={`Rename ${sheet.name}`} onClick={() => setRenamingId(sheet.id)}>
                    Rename
                  </button>
                  <button type="button" aria-label={`Delete ${sheet.name}`} onClick={() => setDeleting(sheet)}>
                    Delete
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
