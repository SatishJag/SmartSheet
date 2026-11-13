import { useRef, type KeyboardEvent } from 'react'
import type { Column } from '../../model/validate'

/** How an edit ended: a blur means focus already went elsewhere, so the grid must not take it back. */
export type CommitReason = 'key' | 'blur' | 'change'

export interface CellEditorProps {
  column: Column
  /** The cell's current value as an editable string. */
  initial: string
  /** Commit the raw string; called at most once per editor. */
  onCommit(raw: string, reason: CommitReason): void
  onCancel(): void
}

/**
 * Returns commit/cancel functions that fire at most once, so Enter followed by the blur
 * that unmounting can cause does not commit twice.
 */
function useOnce(onCommit: CellEditorProps['onCommit'], onCancel: () => void) {
  const done = useRef(false)
  return {
    commit(raw: string, reason: CommitReason) {
      if (done.current) return
      done.current = true
      onCommit(raw, reason)
    },
    cancel() {
      if (done.current) return
      done.current = true
      onCancel()
    },
  }
}

/** Enter commits, Escape cancels; other keys stay inside the editor. */
function editorKeys(e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>, commit: () => void, cancel: () => void) {
  e.stopPropagation()
  if (e.key === 'Enter') {
    e.preventDefault()
    commit()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancel()
  }
}

/** Text input used by TEXT_NUMBER, MULTI_PICKLIST, CONTACT_LIST, DURATION and PREDECESSOR. */
function TextEditor({ column, initial, onCommit, onCancel }: CellEditorProps) {
  const { commit, cancel } = useOnce(onCommit, onCancel)
  return (
    <input
      className="cell-editor"
      type="text"
      aria-label={column.title}
      defaultValue={initial}
      autoFocus
      onKeyDown={(e) => editorKeys(e, () => commit(e.currentTarget.value, 'key'), cancel)}
      onBlur={(e) => commit(e.currentTarget.value, 'blur')}
    />
  )
}

/**
 * Native date input. A partly typed date reads back as '' with `validity.badInput`; that is
 * committed as the literal text "invalid date" so the store reports an error instead of
 * silently clearing the cell.
 */
function DateEditor({ column, initial, onCommit, onCancel }: CellEditorProps) {
  const { commit, cancel } = useOnce(onCommit, onCancel)
  const read = (el: HTMLInputElement) => (el.validity?.badInput ? 'invalid date' : el.value)
  // A native date input cannot hold a formula (it would read back empty and erase it), so a cell
  // holding one is edited as text.
  const isFormula = initial.trimStart().startsWith('=')
  return (
    <input
      className="cell-editor"
      type={isFormula ? 'text' : 'date'}
      aria-label={column.title}
      defaultValue={initial}
      autoFocus
      onKeyDown={(e) => editorKeys(e, () => commit(read(e.currentTarget), 'key'), cancel)}
      onBlur={(e) => commit(read(e.currentTarget), 'blur')}
    />
  )
}

/** Picklist: a blank option plus the column's options. Choosing an option commits it. */
function PicklistEditor({ column, initial, onCommit, onCancel }: CellEditorProps) {
  const { commit, cancel } = useOnce(onCommit, onCancel)
  const options = column.options ?? []
  return (
    <select
      className="cell-editor"
      aria-label={column.title}
      defaultValue={initial}
      autoFocus
      onChange={(e) => commit(e.currentTarget.value, 'change')}
      onKeyDown={(e) => editorKeys(e, () => commit(e.currentTarget.value, 'key'), cancel)}
      onBlur={(e) => commit(e.currentTarget.value, 'blur')}
    >
      <option value="" />
      {/* Keep a stored value that is no longer an option selectable, so opening does not lose it. */}
      {initial !== '' && !options.includes(initial) && <option value={initial}>{initial}</option>}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}

/** The editor for a column type. CHECKBOX has no editor: see `CheckboxCell`. */
export function CellEditor(props: CellEditorProps) {
  switch (props.column.type) {
    case 'DATE':
      return <DateEditor {...props} />
    case 'PICKLIST':
      return <PicklistEditor {...props} />
    default:
      return <TextEditor {...props} />
  }
}

/** A checkbox cell toggles immediately, committing 'true' or 'false'. */
export function CheckboxCell({
  column,
  checked,
  rowNumber,
  onCommit,
}: {
  column: Column
  checked: boolean
  rowNumber: number
  onCommit(raw: string): void
}) {
  return (
    <input
      type="checkbox"
      aria-label={`${column.title}, row ${rowNumber}`}
      checked={checked}
      tabIndex={-1}
      onChange={(e) => onCommit(e.currentTarget.checked ? 'true' : 'false')}
    />
  )
}
