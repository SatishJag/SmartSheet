import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Field, Modal } from './Modal'
import { loadSheetWork, projectFromSheet } from './sheetImport'
import type { AssignmentInput, Person, Project, ProjectInput } from './types'

/**
 * "Add work from a sheet": creates a project linked to one of the user's sheets, spanning the
 * sheet's dates, and assigns every person whose email is a contact on a dated row.
 */
export function ImportSheetDialog({
  client,
  sheets,
  people,
  projects,
  today,
  saveProject,
  saveAssignment,
  onClose,
  onDone,
}: {
  client: SupabaseClient
  sheets: { id: string; name: string }[]
  people: Person[]
  projects: Project[]
  today: string
  saveProject: (input: ProjectInput) => Promise<{ error: string | null; id?: string }>
  saveAssignment: (input: AssignmentInput) => Promise<string | null>
  onClose: () => void
  onDone: (summary: string) => void
}) {
  const linked = new Set(projects.map((p) => p.sheet_id).filter(Boolean))
  const available = sheets.filter((s) => !linked.has(s.id))
  const [sheetId, setSheetId] = useState(available[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    const sheet = sheets.find((s) => s.id === sheetId)
    if (!sheet) return setError('Choose a sheet')
    setBusy(true)
    setError(null)
    try {
      const work = await loadSheetWork(client, sheet.id, people)
      const res = await saveProject(projectFromSheet(sheet.name, sheet.id, work, today))
      if (res.error || !res.id) throw new Error(res.error ?? 'Could not create the project')
      let added = 0
      for (const a of work.assignments) {
        const err = await saveAssignment({ ...a, project_id: res.id })
        if (err) throw new Error(err)
        added++
      }
      const extra = work.unmatched.length ? ` ${work.unmatched.length} contact(s) are not in People: ${work.unmatched.join(', ')}.` : ''
      onDone(`Added "${sheet.name}" as a project with ${added} assignment${added === 1 ? '' : 's'}.${extra}`)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <Modal title="Add work from a sheet" submitLabel="Add work" onClose={onClose} onSubmit={() => void run()} busy={busy || !sheetId} error={error}>
      {available.length === 0 ? (
        <p>Every sheet is already linked to a project. Create a new sheet first.</p>
      ) : (
        <>
          <Field label="Sheet">
            <select value={sheetId} onChange={(e) => setSheetId(e.target.value)}>
              {available.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <p className="rm-muted rm-small">
            The project spans the sheet&apos;s Start and End dates. Rows with a contact whose email matches someone in People
            become assignments for that person.
          </p>
        </>
      )}
    </Modal>
  )
}
