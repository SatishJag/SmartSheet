import { cloneElement, useEffect, useId, useRef, type FormEvent, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'

export interface ModalProps {
  title: string
  children: ReactNode
  onClose: () => void
  onSubmit: () => void
  submitLabel: string
  busy?: boolean
  error?: string | null
  /** Extra buttons on the left of the footer (e.g. Delete). */
  extraActions?: ReactNode
  wide?: boolean
}

/**
 * A form in a modal dialog: labelled by its title, Escape closes, focus starts on the first field
 * and returns to where it was when the dialog closes.
 */
export function Modal({ title, children, onClose, onSubmit, submitLabel, busy, error, extraActions, wide }: ModalProps) {
  const titleId = useId()
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    formRef.current?.querySelector<HTMLElement>('input, select, textarea')?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  function onKeyDown(e: KeyboardEvent) {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!busy) onSubmit()
  }

  return (
    <div className="confirm-backdrop">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className={`rm-modal${wide ? ' is-wide' : ''}`} onKeyDown={onKeyDown}>
        <form ref={formRef} onSubmit={submit} noValidate>
          <h2 id={titleId}>{title}</h2>
          <div className="rm-modal-body">{children}</div>
          {error && <p role="alert">{error}</p>}
          <div className="rm-modal-actions">
            {extraActions}
            <span className="rm-spacer" />
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="rm-primary" disabled={busy}>
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/** A labelled form control; the hint describes the control rather than being part of its name. */
export function Field({ label, children, hint }: { label: string; children: ReactElement<{ id?: string; 'aria-describedby'?: string }>; hint?: string }) {
  const id = useId()
  const hintId = useId()
  return (
    <div className="rm-field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id, 'aria-describedby': hint ? hintId : undefined })}
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  )
}
