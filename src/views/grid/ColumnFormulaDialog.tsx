import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { applySuggestion, suggestFunctions } from '../../formula/autocomplete'
import { checkFormula } from '../../formula/evaluate'
import { formatFormulaValue, formulaErrorText, type FormulaCellResult } from '../../formula/sheetFormulas'
import '../confirmDialog.css'
import './formula.css'

export interface ColumnFormulaDialogProps {
  columnTitle: string
  /** The column's current formula, or '' when it has none. */
  initial: string
  /** What the formula gives in the first row (the row's own value ignored), for the live preview. */
  preview(formula: string): FormulaCellResult | null
  /** The first row's name, shown next to the preview. */
  previewRowLabel: string
  /** Saves the formula; returns an error message to show, or null when done (the caller closes the dialog). */
  onSubmit(formula: string): string | null
  onCancel(): void
}

const FOCUSABLE = 'input, select, textarea, button'

/**
 * A modal for setting a column formula: a text area with function autocomplete (names and one-line
 * signatures), a live preview of the first row's result and syntax errors as you type. Focus starts
 * in the text area, Tab stays inside, Escape closes the suggestions first and then the dialog.
 */
export function ColumnFormulaDialog({ columnTitle, initial, preview, previewRowLabel, onSubmit, onCancel }: ColumnFormulaDialogProps) {
  const titleId = useId()
  const listId = useId()
  const dialogRef = useRef<HTMLFormElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(initial)
  const [caret, setCaret] = useState(initial.length)
  const [active, setActive] = useState(0)
  const [suggestionsOpen, setSuggestionsOpen] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** Where the caret goes once the text a suggestion changed has been rendered. */
  const pendingCaret = useRef<number | null>(null)

  useLayoutEffect(() => {
    const at = pendingCaret.current
    if (at === null || !areaRef.current) return
    pendingCaret.current = null
    areaRef.current.focus()
    areaRef.current.setSelectionRange(at, at)
  })

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const area = areaRef.current
    area?.focus()
    area?.setSelectionRange(initial.length, initial.length)
    return () => {
      if (previous && previous.isConnected) previous.focus()
    }
  }, [initial.length])

  const body = text.trim()
  const formula = body === '' ? '' : body.startsWith('=') ? body : `=${body}`
  const suggestions = useMemo(() => (suggestionsOpen ? suggestFunctions(text, caret).slice(0, 8) : []), [text, caret, suggestionsOpen])
  const syntax = formula === '' ? null : checkFormula(formula)
  const result = useMemo(() => (formula !== '' && syntax?.ok ? preview(formula) : null), [formula, syntax?.ok, preview])

  function accept(index: number) {
    const fn = suggestions[index]
    if (!fn) return
    const next = applySuggestion(text, caret, fn)
    setText(next.text)
    setCaret(next.caret)
    setActive(0)
    setError(null)
    pendingCaret.current = next.caret
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(onSubmit(formula))
  }

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    e.stopPropagation() // keys inside the dialog never reach the grid behind it
    const inArea = e.target === areaRef.current
    if (e.key === 'Escape') {
      e.preventDefault()
      if (suggestions.length > 0) setSuggestionsOpen(false)
      else onCancel()
    } else if (inArea && suggestions.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length)
    } else if (inArea && suggestions.length > 0 && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
      e.preventDefault()
      accept(Math.min(active, suggestions.length - 1))
    } else if (inArea && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault() // Enter saves; Shift+Enter makes a new line
      setError(onSubmit(formula))
    } else if (e.key === 'Tab') {
      const all = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      const i = all.indexOf(document.activeElement as HTMLElement)
      const atEdge = e.shiftKey ? i <= 0 : i === all.length - 1
      if (atEdge) {
        e.preventDefault()
        all[e.shiftKey ? all.length - 1 : 0]?.focus()
      }
    }
  }

  const syncCaret = () => setCaret(areaRef.current?.selectionStart ?? text.length)

  return (
    <div className="confirm-backdrop">
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="confirm-dialog column-dialog formula-dialog"
        onKeyDown={onKeyDown}
        onSubmit={submit}
        noValidate
      >
        <h2 id={titleId}>Column formula: {columnTitle}</h2>
        <p className="column-dialog-hint formula-dialog-help">
          Applies to every row in this column whose cell is empty. A cell you type in keeps its own value. Refer to columns as{' '}
          <code>[Column Name]@row</code>, <code>[Column Name]5</code> or <code>[Column Name]:[Column Name]</code>.
        </p>
        <label className="column-dialog-field">
          Formula
          <textarea
            ref={areaRef}
            className="formula-dialog-input"
            rows={3}
            spellCheck={false}
            autoComplete="off"
            value={text}
            placeholder="=[Quantity]@row * [Rate]@row"
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={suggestions.length > 0 ? `${listId}-${active}` : undefined}
            aria-invalid={syntax && !syntax.ok ? true : undefined}
            onChange={(e) => {
              setText(e.target.value)
              setCaret(e.target.selectionStart)
              setSuggestionsOpen(true)
              setActive(0)
              setError(null)
            }}
            onSelect={syncCaret}
            onKeyUp={syncCaret}
            onClick={syncCaret}
          />
        </label>
        <ul id={listId} role="listbox" aria-label="Functions" className="formula-suggestions" hidden={suggestions.length === 0}>
          {suggestions.map((fn, i) => (
            <li
              key={fn.name}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`formula-suggestion${i === active ? ' is-active' : ''}`}
              // mousedown, not click: the text area must not lose its caret before the name is inserted
              onMouseDown={(e) => {
                e.preventDefault()
                accept(i)
              }}
            >
              <span className="formula-suggestion-sig">{fn.signature}</span>
              {fn.ours && <span className="formula-suggestion-tag">ours</span>}
              <span className="formula-suggestion-doc">{fn.summary}</span>
            </li>
          ))}
        </ul>
        <div className="formula-preview" aria-live="polite" data-testid="formula-preview">
          {formula === '' && <span className="formula-preview-empty">Type a formula to see the first row's result.</span>}
          {syntax && !syntax.ok && (
            <span className="formula-preview-error">
              {syntax.error}: {syntax.message}
            </span>
          )}
          {result && (
            <span className={result.ok ? 'formula-preview-ok' : 'formula-preview-error'}>
              <span className="formula-preview-row">{previewRowLabel}</span>{' '}
              {result.ok ? (
                <>
                  <strong>{result.value === null ? '(empty)' : formatFormulaValue(result.value)}</strong>
                </>
              ) : (
                formulaErrorText(result)
              )}
            </span>
          )}
        </div>
        {error && (
          <p role="alert" className="column-dialog-error">
            {error}
          </p>
        )}
        <div className="confirm-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn-primary column-dialog-submit" disabled={formula === ''}>
            {initial ? 'Save formula' : 'Set formula'}
          </button>
        </div>
      </form>
    </div>
  )
}
