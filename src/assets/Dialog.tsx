import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AssetIcon } from './AssetIcon'

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

export interface DialogProps {
  title: string
  onClose: () => void
  children: ReactNode
  /** Buttons at the bottom. */
  footer?: ReactNode
  /** A wider panel for editors. */
  wide?: boolean
  /** Extra line under the title. */
  description?: string
}

/**
 * A modal dialog: labelled by its title, focus moves in when it opens and returns when it closes, Tab
 * stays inside, Escape closes. Rendered in a portal on <body>, so a transformed ancestor (the springy
 * `.lift` cards) cannot displace it.
 */
export function Dialog({ title, onClose, children, footer, wide, description }: DialogProps) {
  const titleId = useId()
  const descId = useId()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const root = ref.current
    const first = root?.querySelector<HTMLElement>('[data-autofocus], input, select, textarea') ?? root?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? root)?.focus()
    return () => {
      if (previous && previous.isConnected) previous.focus()
    }
  }, [])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Tab' && ref.current) {
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  return createPortal(
    <div className="confirm-backdrop">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`asset-dialog${wide ? ' is-wide' : ''}`}
        onKeyDown={onKeyDown}
      >
        <header className="asset-dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}>
            <AssetIcon name="close" size={18} />
          </button>
        </header>
        {description && (
          <p id={descId} className="asset-dialog-desc">
            {description}
          </p>
        )}
        <div className="asset-dialog-body">{children}</div>
        {footer && <footer className="asset-dialog-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}
