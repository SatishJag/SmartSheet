import { useId, useState, type FormEvent } from 'react'
import { Dialog } from './Dialog'

interface Props {
  title: string
  label: string
  initial?: string
  confirmLabel: string
  /** Saves the typed value; resolves to an error message, or null when it worked (the dialog then closes). */
  onSubmit: (value: string) => Promise<string | null>
  onClose: () => void
  description?: string
}

/** A dialog with one text field (a name), Enter submits. Errors from the save stay in the dialog. */
export function PromptDialog({ title, label, initial = '', confirmLabel, onSubmit, onClose, description }: Props) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = useId()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const err = await onSubmit(value)
    setBusy(false)
    if (err) setError(err)
    else onClose()
  }

  return (
    <Dialog title={title} onClose={onClose} description={description}>
      <form onSubmit={(e) => void submit(e)} className="prompt-form">
        <label htmlFor={id} className="label">
          {label}
        </label>
        <input id={id} value={value} maxLength={100} onChange={(e) => setValue(e.target.value)} aria-invalid={error ? true : undefined} data-autofocus />
        {error && (
          <p role="alert" className="asset-warn">
            {error}
          </p>
        )}
        <div className="asset-dialog-foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
