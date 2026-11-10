import { useEffect, useId, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TEMPLATES, type TemplateId } from '../templates'
import { insertSheetFromTemplate } from '../templates/insertTemplate'

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

export function SheetList({ client, userId, onOpen }: SheetListProps) {
  const [sheets, setSheets] = useState<SheetRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [templateId, setTemplateId] = useState('')
  const inFlight = useRef(false)
  const templateSelectId = useId()

  useEffect(() => {
    let active = true
    client
      .from('sheets')
      .select('id,name,created_at')
      .order('created_at', { ascending: false })
      .then(({ data, error: err }) => {
        if (!active) return
        if (err) setError(err.message)
        else setSheets((data ?? []) as SheetRow[])
      })
    return () => {
      active = false
    }
  }, [client])

  async function createSheet() {
    if (inFlight.current) return
    inFlight.current = true
    setError(null)
    setCreating(true)
    try {
      if (templateId) {
        onOpen(await insertSheetFromTemplate(client, templateId as TemplateId, userId))
      } else {
        const { data, error: err } = await client
          .from('sheets')
          .insert({ name: 'Untitled sheet', owner_id: userId })
          .select('id')
          .single()
        if (err) setError(err.message)
        else onOpen((data as { id: string }).id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the sheet')
    } finally {
      inFlight.current = false
      setCreating(false)
    }
  }

  return (
    <section className="sheet-list">
      <div className="sheet-list-header">
        <h2>Your sheets</h2>
        <div className="sheet-list-new">
          <label htmlFor={templateSelectId}>Template</label>
          <select
            id={templateSelectId}
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            disabled={creating}
          >
            <option value="">Blank sheet</option>
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id} title={t.description}>
                {t.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={createSheet} disabled={creating}>
            New sheet
          </button>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {sheets === null && !error && <p>Loading sheets...</p>}
      {sheets !== null && sheets.length === 0 && <p>No sheets yet</p>}
      {sheets !== null && sheets.length > 0 && (
        <ul>
          {sheets.map((sheet) => (
            <li key={sheet.id}>
              <button type="button" className="sheet-item" onClick={() => onOpen(sheet.id)}>
                <span>{sheet.name}</span>
                <small>{new Date(sheet.created_at).toLocaleDateString()}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
