import { useState, type ReactNode } from 'react'
import { fullOrder } from '../../model/hierarchy'
import { columnFormulaLock, columnLock, isPicklistType, validateColumnTitle } from '../../model/columns'
import { columnFormulaText, previewColumnFormula } from '../../formula/sheetFormulas'
import type { Column } from '../../model/validate'
import { useSheetStore, useSheetStoreApi } from '../../store/SheetStoreContext'
import { ConfirmDialog } from '../ConfirmDialog'
import { InlineRename } from '../InlineRename'
import { ColumnDialog, type ColumnDialogMode, type ColumnDialogValues } from './ColumnDialog'
import { ColumnFormulaDialog } from './ColumnFormulaDialog'
import { ColumnHeaderMenu, type ColumnMenuAction, type ColumnMenuItem } from './ColumnHeaderMenu'
import './columnMenu.css'

type DialogState = { mode: 'add'; afterColId?: string } | { mode: Exclude<ColumnDialogMode, 'add'>; colId: string }

export interface ColumnManagement {
  /** The menu button for a column header. */
  menuButton(colId: string): ReactNode
  /** The inline rename field when this column is being renamed, else null. */
  renameField(colId: string): ReactNode | null
  /** Opens a column's header menu (Shift+F10 / context-menu key on one of its cells). */
  openMenu(colId: string): void
  /** The "Add column" button shown at the end of the header. */
  addColumnButton: ReactNode
  /** Open dialogs (add/type/options, delete confirmation). */
  dialogs: ReactNode
}

const NO_INSERT_LEFT = 'New columns go to the right of the primary column'

/** Column header menus, the add-column affordance and their dialogs, wired to the sheet store. */
export function useColumnManagement(columns: Column[]): ColumnManagement {
  const api = useSheetStoreApi()
  const data = useSheetStore((s) => s.data)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Column | null>(null)
  const [formulaFor, setFormulaFor] = useState<string | null>(null)

  const byId = (id: string) => columns.find((c) => c.id === id)

  function items(col: Column, index: number): ColumnMenuItem[] {
    const list: ColumnMenuItem[] = [
      { action: 'rename', label: 'Rename column' },
      { action: 'insertLeft', label: 'Insert column left', disabledReason: index === 0 ? NO_INSERT_LEFT : null },
      { action: 'insertRight', label: 'Insert column right' },
    ]
    if (isPicklistType(col.type)) list.push({ action: 'options', label: 'Edit dropdown options' })
    list.push({
      action: 'formula',
      label: col.formula ? 'Edit column formula' : 'Set column formula',
      disabledReason: data ? columnFormulaLock(data, col.id) : null,
    })
    if (col.formula) list.push({ action: 'clearFormula', label: 'Clear column formula' })
    list.push(
      { action: 'type', label: 'Change column type', disabledReason: data ? columnLock(data, col.id, 'retype') : null },
      { action: 'delete', label: 'Delete column', disabledReason: data ? columnLock(data, col.id, 'delete') : null },
    )
    return list
  }

  function onSelect(col: Column, index: number, action: ColumnMenuAction) {
    switch (action) {
      case 'rename':
        setRenaming(col.id)
        break
      case 'insertLeft':
        setDialog({ mode: 'add', afterColId: columns[index - 1]?.id })
        break
      case 'insertRight':
        setDialog({ mode: 'add', afterColId: col.id })
        break
      case 'options':
      case 'type':
        setDialog({ mode: action, colId: col.id })
        break
      case 'formula':
        setFormulaFor(col.id)
        break
      case 'clearFormula':
        api.getState().setColumnFormula(col.id, null)
        break
      case 'delete':
        setPendingDelete(col)
        break
    }
  }

  function submit(d: DialogState, v: ColumnDialogValues): string | null {
    const s = api.getState()
    let res
    if (d.mode === 'add') res = s.addColumn(v.title, v.type, v.options, d.afterColId)
    else if (d.mode === 'type') res = s.changeColumnType(d.colId, v.type, v.options)
    else res = s.setColumnOptions(d.colId, v.options)
    if (!res.ok) return res.error
    setDialog(null)
    return null
  }

  const dialogColumn = dialog && dialog.mode !== 'add' ? byId(dialog.colId) : undefined
  const formulaColumn = formulaFor ? byId(formulaFor) : undefined

  return {
    menuButton(colId) {
      const index = columns.findIndex((c) => c.id === colId)
      const col = columns[index]
      if (!col) return null
      return (
        <ColumnHeaderMenu
          columnTitle={col.title}
          items={items(col, index)}
          open={menuFor === colId}
          onOpenChange={(open) => setMenuFor(open ? colId : null)}
          onSelect={(action) => onSelect(col, index, action)}
        />
      )
    },

    renameField(colId) {
      const col = renaming === colId ? byId(colId) : undefined
      if (!col) return null
      return (
        // Keys typed while renaming must not reach the grid (Enter would open the active cell's editor).
        <span className="column-rename" onKeyDown={(e) => e.stopPropagation()}>
          <InlineRename
          initial={col.title}
          label={`Rename column ${col.title}`}
          validate={(raw) => {
            const v = validateColumnTitle(raw, api.getState().data?.columns ?? columns, colId)
            return v.ok ? { ok: true, name: v.title } : v
          }}
          onSave={async (title) => {
            const res = api.getState().renameColumn(colId, title)
            if (!res.ok) return res.error
            setRenaming(null)
            return null
          }}
          onCancel={() => setRenaming(null)}
          />
        </span>
      )
    },

    openMenu(colId) {
      if (byId(colId)) setMenuFor(colId)
    },

    addColumnButton: (
      <button type="button" className="add-column-button" aria-label="Add column" title="Add column" onClick={() => setDialog({ mode: 'add' })}>
        +
      </button>
    ),

    dialogs: (
      <>
        {dialog && (dialog.mode === 'add' || dialogColumn) && (
          <ColumnDialog
            key={dialog.mode + (dialog.mode === 'add' ? '' : dialog.colId)}
            mode={dialog.mode}
            columnTitle={dialogColumn?.title}
            initialType={dialogColumn?.type}
            initialOptions={dialogColumn?.options}
            onSubmit={(v) => submit(dialog, v)}
            onCancel={() => setDialog(null)}
          />
        )}
        {formulaColumn && (
          <ColumnFormulaDialog
            key={formulaColumn.id}
            columnTitle={formulaColumn.title}
            initial={columnFormulaText(formulaColumn) ?? ''}
            previewRowLabel="Row 1 →"
            preview={(formula) => {
              const d = api.getState().data
              const first = d ? fullOrder(d.rows)[0] : undefined // only while the dialog is open
              return d && first ? previewColumnFormula(d, formulaColumn.id, formula, first) : null
            }}
            onSubmit={(formula) => {
              const res = api.getState().setColumnFormula(formulaColumn.id, formula)
              if (!res.ok) return res.error
              setFormulaFor(null)
              return null
            }}
            onCancel={() => setFormulaFor(null)}
          />
        )}
        {pendingDelete && (
          <ConfirmDialog
            title="Delete column"
            message={`Delete the "${pendingDelete.title}" column and all of its values? Formulas that use it will show an error.`}
            confirmLabel="Delete column"
            onConfirm={() => {
              api.getState().deleteColumn(pendingDelete.id)
              setPendingDelete(null)
            }}
            onCancel={() => setPendingDelete(null)}
          />
        )}
      </>
    ),
  }
}
