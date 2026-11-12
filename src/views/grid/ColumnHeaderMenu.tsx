import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

export type ColumnMenuAction = 'rename' | 'insertLeft' | 'insertRight' | 'options' | 'type' | 'delete'

export interface ColumnMenuItem {
  action: ColumnMenuAction
  label: string
  /** Why the item is unavailable; the item is shown disabled with this note. */
  disabledReason?: string | null
}

export interface ColumnHeaderMenuProps {
  columnTitle: string
  items: ColumnMenuItem[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (action: ColumnMenuAction) => void
}

/**
 * The menu button in a column header and its popup menu (rendered in a portal so the header's
 * overflow does not clip it). The button stays out of the tab order like the header's sort button
 * (the grid keeps a single tab stop); keyboard users open it with Shift+F10 or the context-menu key
 * on any cell of the column. Arrow keys, Home and End move between items, Escape closes the menu and
 * returns focus to where it was, Tab or a click outside closes it.
 */
export function ColumnHeaderMenu({ columnTitle, items, open, onOpenChange, onSelect }: ColumnHeaderMenuProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const menuId = useId()
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useLayoutEffect(() => {
    if (!open) return
    returnFocus.current = document.activeElement as HTMLElement | null
    const r = buttonRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 2, left: Math.max(4, Math.min(r.left, window.innerWidth - 230)) })
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
    first?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) onOpenChange(false)
    }
    // The menu is placed under the button once; scrolling the grid would leave it behind.
    const onScroll = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) onOpenChange(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [open, onOpenChange])

  function close(restore: boolean) {
    onOpenChange(false)
    const target = returnFocus.current?.isConnected ? returnFocus.current : buttonRef.current
    if (restore) target?.focus()
  }

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation() // keys in the menu never reach the grid behind it
    const all = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const i = all.indexOf(document.activeElement as HTMLElement)
    const focusAt = (n: number) => all[(n + all.length) % all.length]?.focus()
    if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      close(true)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusAt(i + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusAt(i - 1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      focusAt(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      focusAt(all.length - 1)
    }
  }

  function choose(item: ColumnMenuItem) {
    if (item.disabledReason) return
    // Focus goes back first, so a dialog opened by the action returns it there when it closes.
    close(true)
    onSelect(item.action)
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="column-menu-button"
        tabIndex={-1}
        aria-label={`Column menu for ${columnTitle}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-keyshortcuts="Shift+F10"
        onClick={() => onOpenChange(!open)}
        onKeyDown={(e) => e.stopPropagation()} // Enter/Space activate the button, not the grid's active cell
      />
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={`${columnTitle} column`}
            className="column-menu"
            style={{ top: pos.top, left: pos.left }}
            onKeyDown={onMenuKeyDown}
          >
            {items.map((item) => (
              <button
                key={item.action}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`column-menu-item${item.action === 'delete' ? ' is-danger' : ''}`}
                aria-disabled={item.disabledReason ? true : undefined}
                title={item.disabledReason ?? undefined}
                onClick={() => choose(item)}
              >
                {item.label}
                {item.disabledReason && <span className="column-menu-note">{item.disabledReason}</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
