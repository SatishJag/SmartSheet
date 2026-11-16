import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import './formula.css'

export interface FormulaBarProps {
  /** E.g. "Total · row 3"; null when no cell is active. */
  label: string | null
  /** The active cell's text as the editor would show it (a formula starts with "="). */
  text: string
  /** Whether the cell can be edited here. */
  editable: boolean
  /** Why it cannot, shown as the tooltip. */
  readOnlyReason?: string
  /** Set when `text` is the column's formula rather than the cell's own. */
  fromColumn: boolean
  /** The cell's error ("#DIVIDE BY ZERO: ..."), if it has one. */
  error?: string
  /** Commit a changed text (Enter, or leaving the bar with unsaved changes). */
  onCommit(text: string): void
  /** Hand the keyboard back to the grid cell (after Enter or Escape). */
  onReturn(): void
}

/**
 * The formula bar above the grid: shows the active cell's formula (`=...`, or its plain value) and
 * edits it. Enter commits, Escape puts the original text back, and leaving the bar with changes
 * commits them like leaving a cell editor does. Unchanged text is never committed.
 */
export function FormulaBar({ label, text, editable, readOnlyReason, fromColumn, error, onCommit, onReturn }: FormulaBarProps) {
  const [draft, setDraft] = useState(text)
  const settled = useRef(false) // Enter/Escape already dealt with this edit; the blur that follows must not commit

  // Follow the cell: a new active cell, or its value changing from elsewhere, replaces the draft.
  useEffect(() => {
    setDraft(text)
  }, [text, label])

  function commit() {
    if (draft !== text) onCommit(draft)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation() // keys typed here never reach the grid
    if (e.key === 'Enter') {
      e.preventDefault()
      settled.current = true
      commit()
      onReturn()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      settled.current = true
      setDraft(text)
      onReturn()
    }
  }

  const disabled = label === null || !editable
  const note = error ?? (fromColumn ? 'Column formula' : undefined)
  return (
    <div className="formula-bar" role="group" aria-label="Formula bar">
      <span className="formula-bar-ref" title={label ?? undefined}>
        {label ?? 'No cell selected'}
      </span>
      <span className="formula-bar-fx" aria-hidden="true">
        fx
      </span>
      <input
        className="formula-bar-input"
        type="text"
        aria-label="Formula bar"
        spellCheck={false}
        autoComplete="off"
        value={draft}
        disabled={disabled}
        title={label !== null && !editable ? readOnlyReason : undefined}
        placeholder={label === null ? 'Select a cell to see or edit its formula' : ''}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          settled.current = false
        }}
        onBlur={() => {
          if (!settled.current) commit()
          settled.current = false
        }}
      />
      {note && (
        <span className={`formula-bar-note${error ? ' is-error' : ' is-column'}`} title={note}>
          {note}
        </span>
      )}
    </div>
  )
}
