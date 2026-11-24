import { useId, useRef, useState, type KeyboardEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { addProject, checkNewProject, normaliseCode } from './addProject'
import { PIcon } from './PIcon'
import type { Project } from './types'

/** The value of the Project list's last option, which opens these fields. */
export const NEW_PROJECT = '__new__'

export interface NewProjectFieldsProps {
  client: SupabaseClient
  userId: string
  /** The project type on screen when Add project is selected; the project is saved under it. */
  projectType: string
  onAdded: (project: Project) => void
  onCancel: () => void
}

/**
 * Code and Name for a project the planner adds to the shared list (Project → "+ New project…").
 * Add project saves it; nothing is saved while a field is wrong or when the code already exists.
 */
export function NewProjectFields({ client, userId, projectType, onAdded, onCancel }: NewProjectFieldsProps) {
  const id = useId()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [problems, setProblems] = useState<{ code?: string; name?: string }>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** Set at once (state lags a render), so a double press saves once. */
  const busy = useRef(false)

  async function add() {
    if (busy.current) return
    const found = checkNewProject(normaliseCode(code), name)
    setProblems(found)
    setFailure(null)
    if (found.code || found.name) return
    busy.current = true
    setSaving(true)
    const result = await addProject(client, userId, { code, name, projectType })
    busy.current = false
    setSaving(false)
    if (result.ok) onAdded(result.project)
    else setFailure(result.error)
  }

  // Enter adds the project instead of submitting the wizard's form.
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    void add()
  }

  const described = (field: 'code' | 'name', hint?: string) =>
    [hint, problems[field] ? `${id}-${field}-error` : undefined].filter(Boolean).join(' ') || undefined

  return (
    <div role="group" aria-label="New project" className="planner-new-project">
      <div className="planner-field">
        <label htmlFor={`${id}-code`} className="planner-label">
          Code
        </label>
        <input
          id={`${id}-code`}
          value={code}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={onKeyDown}
          aria-invalid={problems.code ? true : undefined}
          aria-describedby={described('code', `${id}-code-hint`)}
        />
        <small id={`${id}-code-hint`}>Capitals, digits and hyphens, up to 20 (e.g. BKK-04)</small>
        {problems.code && <Problem id={`${id}-code-error`}>{problems.code}</Problem>}
      </div>
      <div className="planner-field">
        <label htmlFor={`${id}-name`} className="planner-label">
          Name
        </label>
        <input
          id={`${id}-name`}
          value={name}
          autoComplete="off"
          placeholder="e.g. Bangkok 4"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onKeyDown}
          aria-invalid={problems.name ? true : undefined}
          aria-describedby={described('name')}
        />
        {problems.name && <Problem id={`${id}-name-error`}>{problems.name}</Problem>}
      </div>
      {failure && (
        <Problem id={`${id}-error`} alert>
          {failure}
        </Problem>
      )}
      <div className="planner-new-project-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void add()} disabled={saving}>
          {saving ? 'Adding…' : 'Add project'}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  )
}

const Problem = ({ id, children, alert = false }: { id: string; children: string; alert?: boolean }) => (
  <small id={id} className="planner-error" role={alert ? 'alert' : undefined}>
    <PIcon name="alertCircle" size={14} />
    {children}
  </small>
)
