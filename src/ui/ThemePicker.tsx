import { useEffect, useId, useRef, useState } from 'react'
import { applyTheme, readTheme, THEMES } from './theme'
import './themePicker.css'

/** A header button that opens a popover of colour swatches. The choice is saved in localStorage. */
export function ThemePicker() {
  const [theme, setTheme] = useState(readTheme)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverId = useId()

  useEffect(() => {
    if (!open) return undefined
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = THEMES.find((t) => t.id === theme) ?? THEMES[0]

  return (
    <div className="theme-picker" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="theme-picker-button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label="Change colour theme"
        title="Colour theme"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="theme-dot" style={{ background: current.color }} />
      </button>
      {open && (
        <div id={popoverId} role="dialog" aria-label="Colour theme" className="theme-popover card rise">
          <div role="radiogroup" aria-label="Colour theme" className="theme-swatches">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={theme === t.id}
                aria-label={t.label}
                className="theme-swatch"
                onClick={() => setTheme(applyTheme(t.id))}
              >
                <span className="theme-dot" style={{ background: t.color }}>
                  {theme === t.id && (
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                  )}
                </span>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
