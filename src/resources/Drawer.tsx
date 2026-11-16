import { useEffect, useId, type ReactNode } from 'react'

/**
 * A non-modal side panel (a bottom sheet on phones): the page behind stays usable. Escape closes it;
 * focus moves to its heading when it opens and back to where it was when it closes.
 */
export function Drawer({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  const titleId = useId()
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    return () => {
      if (previous && previous.isConnected) previous.focus()
    }
  }, [])
  return (
    <aside
      className="res-drawer rise"
      role="complementary"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <header className="res-drawer-head">
        <div>
          <h2 id={titleId} tabIndex={-1} ref={(el) => el?.focus({ preventScroll: true })}>
            {title}
          </h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}>
          <span aria-hidden="true" className="res-x">×</span>
        </button>
      </header>
      <div className="res-drawer-body">{children}</div>
    </aside>
  )
}
