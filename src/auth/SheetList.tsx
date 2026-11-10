import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

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
    setError(null)
    setCreating(true)
    try {
      const { data, error: err } = await client
        .from('sheets')
        .insert({ name: 'Untitled sheet', owner_id: userId })
        .select('id')
        .single()
      if (err) setError(err.message)
      else onOpen((data as { id: string }).id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the sheet')
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="sheet-list">
      <div className="sheet-list-header">
        <h2>Your sheets</h2>
        <button type="button" onClick={createSheet} disabled={creating}>
          New sheet
        </button>
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
