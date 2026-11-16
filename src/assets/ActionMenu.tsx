import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AssetIcon, type AssetIconName } from './AssetIcon'

export interface MenuItem {
  label: string
  onSelect: () => void
  icon?: AssetIconName
  danger?: boolean
  disabled?: boolean
}

interface Props {
  /** Accessible name of the button, e.g. "Actions for Tower A". */
  label: string
  items: MenuItem[]
  /** Button content; the three-dots icon by default. */
  children?: ReactNode
  className?: string
  /** Align the menu to the button's right edge (default) or left edge. */
  align?: 'right' | 'left'
  /** Draws the button as a labelled pill instead of an icon button. */
  pill?: boolean
}

/**
 * A button that opens a menu (role="menu"): arrow keys move, Enter / Space select, Escape closes and
 * returns focus. The list is drawn in a portal with fixed coordinates, so no scroll container or
 * overflow-hidden card can clip it; it flips above the button when there is no room below.
 */
export function ActionMenu({ label, items, children, className, align = 'right', pill }: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left?: number; right?: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }, [])

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return
    const r = buttonRef.current.getBoundingClientRect()
    const below = window.innerHeight - r.bottom
    const vertical = below < 260 && r.top > below ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }
    setPos({ ...vertical, ...(align === 'right' ? { right: Math.max(8, window.innerWidth - r.right) } : { left: Math.max(8, r.left) }) })
  }, [open, align])

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true })
    const away = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !buttonRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const dismiss = () => setOpen(false)
    const onScroll = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', away)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, pos])

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const list = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    const i = list.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = list.length
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n]?.focus({ preventScroll: true })
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      list[e.key === 'Home' ? 0 : list.length - 1]?.focus()
    } else if (e.key === 'Tab') {
      close(false)
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`${pill ? 'btn btn-sm' : 'btn-icon'} ${className ?? ''}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={pill ? undefined : label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        {children ?? <AssetIcon name="more" size={18} />}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            className="action-menu rise"
            style={{ ...pos, visibility: pos ? 'visible' : 'hidden' }}
            onKeyDown={onMenuKey}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={item.danger ? 'is-danger' : undefined}
                onClick={() => {
                  close(false)
                  item.onSelect()
                }}
              >
                {item.icon && <AssetIcon name={item.icon} size={16} />}
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
