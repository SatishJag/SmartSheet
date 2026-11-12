import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import './confirmDialog.css'

export interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
  /** Return focus to the previously focused element on close. Default true. */
  restoreFocus?: boolean
}

/**
 * A modal confirmation (role="alertdialog"): labelled by its title, described by its message.
 * Focus moves to Cancel when it opens (the safe choice for destructive actions), Tab cycles
 * within the dialog, Escape cancels, and focus returns to where it was when it closes.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  restoreFocus = true,
}: ConfirmDialogProps) {
  const titleId = useId()
  const messageId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    return () => {
      if (restoreFocus && previous && previous.isConnected) previous.focus()
    }
  }, [restoreFocus])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation() // keys inside the dialog never reach the grid or page behind it
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const next = document.activeElement === cancelRef.current ? confirmRef.current : cancelRef.current
      next?.focus()
    }
  }

  return (
    <div className="confirm-backdrop">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="confirm-dialog"
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={messageId}>{message}</p>
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button ref={confirmRef} type="button" className="confirm-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
