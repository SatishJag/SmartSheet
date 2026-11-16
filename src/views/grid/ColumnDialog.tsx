import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { COLUMN_TYPE_LABELS, isPicklistType, USER_COLUMN_TYPES } from '../../model/columns'
import type { ColumnType } from '../../model/validate'
import '../confirmDialog.css'

export type ColumnDialogMode = 'add' | 'type' | 'options'

export interface ColumnDialogValues {
  title: string
  type: ColumnType
  options: string[]
}

export interface ColumnDialogProps {
  mode: ColumnDialogMode
  /** The column being changed (type and options modes). */
  columnTitle?: string
  initialType?: ColumnType
  initialOptions?: string[]
  /** Applies the change; returns an error message to show, or null when done (the caller closes the dialog). */
  onSubmit: (values: ColumnDialogValues) => string | null
  onCancel: () => void
}

const HEADINGS: Record<ColumnDialogMode, string> = {
  add: 'Add column',
  type: 'Change column type',
  options: 'Edit dropdown options',
}

const SUBMIT: Record<ColumnDialogMode, string> = {
  add: 'Add column',
  type: 'Change type',
  options: 'Save options',
}

const FOCUSABLE = 'input, select, textarea, button'

/**
 * A modal form for adding a column, changing a column's type, or editing a dropdown's options.
 * Focus moves to the first field when it opens, Tab stays inside, Escape cancels, and focus
 * returns to where it was when it closes. Errors from the store are shown as an alert.
 */
export function ColumnDialog({ mode, columnTitle, initialType = 'TEXT_NUMBER', initialOptions = [], onSubmit, onCancel }: ColumnDialogProps) {
  const titleId = useId()
  const errorId = useId()
  const dialogRef = useRef<HTMLFormElement>(null)
  const [title, setTitle] = useState('')
  const [type, setType] = useState<ColumnType>(initialType)
  const [options, setOptions] = useState(initialOptions.join('\n'))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    return () => {
      if (previous && previous.isConnected) previous.focus()
    }
  }, [])

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(onSubmit({ title, type, options: options.split('\n') }))
  }

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    e.stopPropagation() // keys inside the dialog never reach the grid behind it
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Tab') {
      const all = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      const i = all.indexOf(document.activeElement as HTMLElement)
      const atEdge = e.shiftKey ? i <= 0 : i === all.length - 1
      if (atEdge) {
        e.preventDefault()
        all[e.shiftKey ? all.length - 1 : 0]?.focus()
      }
    }
  }

  const showOptions = mode === 'options' || isPicklistType(type)
  const describedBy = error ? errorId : undefined

  return (
    <div className="confirm-backdrop">
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="confirm-dialog column-dialog"
        onKeyDown={onKeyDown}
        onSubmit={submit}
        noValidate
      >
        <h2 id={titleId}>{columnTitle && mode !== 'add' ? `${HEADINGS[mode]}: ${columnTitle}` : HEADINGS[mode]}</h2>
        {mode === 'add' && (
          <label className="column-dialog-field">
            Column name
            <input
              type="text"
              value={title}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              onChange={(e) => {
                setTitle(e.target.value)
                setError(null)
              }}
            />
          </label>
        )}
        {mode !== 'options' && (
          <label className="column-dialog-field">
            Column type
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value as ColumnType)
                setError(null)
              }}
            >
              {USER_COLUMN_TYPES.map((t) => (
                <option key={t} value={t}>
                  {COLUMN_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
        )}
        {showOptions && (
          <label className="column-dialog-field">
            Options (one per line)
            <textarea
              rows={5}
              value={options}
              aria-describedby={describedBy}
              onChange={(e) => {
                setOptions(e.target.value)
                setError(null)
              }}
            />
          </label>
        )}
        {mode === 'type' && <p className="column-dialog-hint">Values that do not fit the new type will be cleared.</p>}
        {error && (
          <p id={errorId} role="alert" className="column-dialog-error">
            {error}
          </p>
        )}
        <div className="confirm-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="column-dialog-submit">
            {SUBMIT[mode]}
          </button>
        </div>
      </form>
    </div>
  )
}
