import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { validateSheetName } from '../auth/sheetName'

export interface InlineRenameProps {
  initial: string
  /** Saves the validated name; resolves to an error message, or null on success. */
  onSave: (name: string) => Promise<string | null>
  onCancel: () => void
  label?: string
}

/**
 * Inline name editor: Enter validates and saves (staying open with an alert on any error),
 * Escape cancels. Focus moves into the input when it opens.
 */
export function InlineRename({ initial, onSave, onCancel, label = 'Sheet name' }: InlineRenameProps) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const errorId = useId()

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  async function save() {
    const valid = validateSheetName(value)
    if (!valid.ok) {
      setError(valid.error)
      return
    }
    setSaving(true)
    const failure = await onSave(valid.name)
    setSaving(false)
    if (failure) setError(failure)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!saving) void save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <span className="inline-rename">
      <input
        ref={inputRef}
        type="text"
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        value={value}
        readOnly={saving}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }}
        onKeyDown={onKeyDown}
      />
      {error && (
        <span id={errorId} role="alert" className="inline-rename-error">
          {error}
        </span>
      )}
    </span>
  )
}
