import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { useTable } from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Column } from '../../model/validate'
import { useSheetStore, useSheetStoreApi } from '../../store/SheetStoreContext'
import { ConfirmDialog } from '../ConfirmDialog'
import { CellEditor, CheckboxCell, type CommitReason } from './cellEditors'
import {
  describeRejections,
  parseTsv,
  planPaste,
  rangeCells,
  rangeContains,
  rangeFrom,
  rangeSize,
  serializeTsv,
  type CellRange,
  type Rejection,
} from './clipboard'
import {
  buildColumnDefs,
  displayText,
  editString,
  formulaError,
  gridFeatures,
  isEditable,
  readOnlyReason,
  ROW_NUMBER_COLUMN_ID,
  type GridRow,
} from './columns'
import { FilterBar } from './FilterBar'
import { HierarchyCell } from './HierarchyCell'
import { PredecessorCell } from './PredecessorCell'
import { useGridViewState } from './useGridViewState'
import { useColumnManagement } from './useColumnManagement'
import { useRowDrag } from './useRowDrag'
import { buildDisplayRows, buildGridRows, effectiveFilter, effectiveSort, isDescendant, type DisplayRow } from './viewModel'
import { fixedViewport, measuredViewport } from './viewport'
import './grid.css'

export const ROW_HEIGHT = 32
const OVERSCAN = 10
const EMPTY_COLUMNS: Column[] = []

type ViewRow = GridRow & DisplayRow
const ARIA_SORT = { asc: 'ascending', desc: 'descending' } as const

interface ActiveCell {
  rowId: string
  colId: string
}

export interface GridViewProps {
  /** Height of the scrollable grid in px. Measured from the layout when omitted. */
  viewportHeight?: number
}

/**
 * The sheet grid: rows in tree order (or sorted per sibling group / filtered), virtualized, one
 * active cell at a time, typed editors, hierarchy controls. Everything comes from the sheet store
 * via context; edits go through store actions. Sort, filter and collapse are UI-only state.
 */
export function GridView({ viewportHeight }: GridViewProps) {
  const api = useSheetStoreApi()
  const data = useSheetStore((s) => s.data)
  const scheduled = useSheetStore((s) => s.scheduled)
  const errors = useSheetStore((s) => s.errors)

  const columns = data?.columns ?? EMPTY_COLUMNS
  const columnDefs = useMemo(() => buildColumnDefs(columns), [columns])
  const { view, toggleCollapsed, expand, cycleSort, setFilter } = useGridViewState()
  const columnUi = useColumnManagement(columns)

  const allRows = useMemo(() => buildGridRows(data, scheduled), [data, scheduled])
  const rows = useMemo<ViewRow[]>(() => {
    const byId = new Map(allRows.map((r) => [r.id, r]))
    return buildDisplayRows(data, scheduled, view, allRows).map((d) => ({ ...byId.get(d.id)!, ...d }))
  }, [data, scheduled, view, allRows])
  const parentById = useMemo(() => new Map(data?.rows.map((r) => [r.id, r.parentId])), [data])
  const parentOf = (id: string) => parentById.get(id)
  const filterActive = effectiveFilter(columns, view.filter) !== null
  const rowDrag = useRowDrag({
    enabled: !filterActive && effectiveSort(columns, view.sort) === null,
    parentOf,
    onMove: (id, targetId) => api.getState().moveRow(id, targetId, parentOf(targetId) ?? null),
  })

  const errorByCell = useMemo(() => new Map(errors.map((e) => [`${e.rowId}:${e.colId}`, e.message])), [errors])

  const table = useTable({
    features: gridFeatures,
    columns: columnDefs,
    data: rows as GridRow[],
    columnResizeMode: 'onChange',
    getRowId: (r) => r.id,
  })
  const headers = table.getHeaderGroups()[0]?.headers ?? []
  const widthOf = (colId: string) => table.getColumn(colId)?.getSize() ?? 0
  const totalWidth = table.getTotalSize()

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    scrollPaddingStart: ROW_HEIGHT, // the sticky header covers the first row's height
    getItemKey: (i) => rows[i]?.id ?? i,
    ...(viewportHeight !== undefined ? fixedViewport(viewportHeight) : measuredViewport),
  })

  const [active, setActive] = useState<ActiveCell | null>(null)
  /** The fixed corner of a range selection; the active cell is the moving corner. Null: no range. */
  const [anchor, setAnchor] = useState<ActiveCell | null>(null)
  /** Set by a Shift+mousedown that already extended the selection, so its click does not collapse it. */
  const extendedByMouse = useRef(false)
  const [editing, setEditing] = useState(false)
  /** A parent row waiting for the user to confirm its deletion. */
  const [pendingDelete, setPendingDelete] = useState<{ rowId: string; subRows: number } | null>(null)
  /** Set when the active cell should take keyboard focus after the next render. */
  const focusRequest = useRef(false)

  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows])
  const colIndex = useMemo(() => new Map(columns.map((c, i) => [c.id, i])), [columns])
  const activeRowIdx = active ? rowIndex.get(active.rowId) : undefined
  const activeColIdx = active ? colIndex.get(active.colId) : undefined
  const activeValid = activeRowIdx !== undefined && activeColIdx !== undefined
  // The selected rectangle, in visible-row and column indices. An anchor that is no longer
  // visible (collapsed, filtered out, deleted) leaves just the active cell selected.
  const anchorRowIdx = anchor ? rowIndex.get(anchor.rowId) : undefined
  const anchorColIdx = anchor ? colIndex.get(anchor.colId) : undefined
  const selection: CellRange | null = activeValid
    ? rangeFrom(
        { row: activeRowIdx, col: activeColIdx },
        anchorRowIdx !== undefined && anchorColIdx !== undefined
          ? { row: anchorRowIdx, col: anchorColIdx }
          : { row: activeRowIdx, col: activeColIdx },
      )
    : null
  const multiSelected = selection !== null && rangeSize(selection) > 1

  useEffect(() => {
    if (!focusRequest.current || !active || editing) return
    focusRequest.current = false
    const cells = scrollRef.current?.querySelectorAll<HTMLElement>('[role="gridcell"]') ?? []
    const el = Array.from(cells).find((c) => c.dataset.rowId === active.rowId && c.dataset.colId === active.colId)
    el?.focus()
  }, [active, editing])

  /** Makes a cell active. With `extend`, the range from the anchor (or the old active cell) grows to it. */
  function select(rowId: string, colId: string, focus: boolean, extend = false) {
    setAnchor(extend ? (anchor ?? active) : null)
    focusRequest.current = focus
    setActive({ rowId, colId })
    setEditing(false)
  }

  function startEdit(row: GridRow, col: Column) {
    if (!isEditable(col, row)) return
    if (col.type === 'CHECKBOX') {
      toggleCheckbox(row, col)
      return
    }
    setActive({ rowId: row.id, colId: col.id })
    setEditing(true)
  }

  function commit(rowId: string, colId: string, raw: string, reason: CommitReason, initial: string) {
    // An unchanged value is not an edit, unless re-committing it clears an error on the cell.
    if (raw !== initial || errorByCell.has(`${rowId}:${colId}`)) api.getState().setCell(rowId, colId, raw)
    focusRequest.current = reason !== 'blur'
    setEditing(false)
  }

  function cancel() {
    focusRequest.current = true
    setEditing(false)
  }

  function toggleCheckbox(row: GridRow, col: Column) {
    api.getState().setCell(row.id, col.id, row.record.cells[col.id] === true ? 'false' : 'true')
  }

  function onGridKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (editing || !activeValid) return
    const move: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }
    if (e.key === 'Tab' && activeColIdx === 0 && (e.target as HTMLElement).getAttribute('role') === 'gridcell') {
      // Primary column: Tab indents, Shift+Tab outdents. Elsewhere Tab moves focus as usual.
      e.preventDefault()
      shiftActiveRow(e.shiftKey ? 'outdent' : 'indent')
    } else if (e.key in move) {
      e.preventDefault()
      const [dr, dc] = move[e.key]
      const r = clamp(activeRowIdx + dr, rows.length)
      const c = clamp(activeColIdx + dc, columns.length)
      virtualizer.scrollToIndex(r)
      // Shift+Arrow extends the selection; a plain arrow collapses it.
      select(rows[r].id, columns[c].id, true, e.shiftKey)
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault()
      startEdit(rows[activeRowIdx], columns[activeColIdx])
    } else if (e.key === 'Escape' && multiSelected) {
      e.preventDefault()
      setAnchor(null)
    } else if (
      (e.key === 'Delete' || e.key === 'Backspace') &&
      (e.target as HTMLElement).getAttribute('role') === 'gridcell'
    ) {
      e.preventDefault()
      // Delete on a single cell deletes its row (as before); on a range, and Backspace always,
      // clears the editable cells instead.
      if (e.key === 'Delete' && !multiSelected) requestDelete()
      else if (selection) clearCells(selection)
    } else if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && (e.target as HTMLElement).getAttribute('role') === 'gridcell') {
      e.preventDefault()
      columnUi.openMenu(columns[activeColIdx].id) // the active column's header menu
    }
  }

  /** What a cell puts on the clipboard: a formula's text, otherwise the text the cell shows. */
  function copyText(col: Column, row: GridRow): string {
    return row.formulaOf?.(col.id) ? editString(col, row) : displayText(col, row)
  }

  /** Whether a clipboard event belongs to the grid's cells (not an open editor). */
  function isCellClipboardEvent(e: ClipboardEvent<HTMLDivElement>): boolean {
    return !editing && selection !== null && (e.target as HTMLElement).closest?.('[role="gridcell"]') != null
  }

  function onGridCopy(e: ClipboardEvent<HTMLDivElement>, cut = false) {
    if (!isCellClipboardEvent(e) || !selection) return
    e.preventDefault()
    const matrix: string[][] = []
    for (let r = selection.top; r <= selection.bottom; r++) {
      matrix.push(columns.slice(selection.left, selection.right + 1).map((col) => copyText(col, rows[r])))
    }
    e.clipboardData.setData('text/plain', serializeTsv(matrix))
    if (cut) clearCells(selection, 'cut')
  }

  /**
   * Pastes TSV from the top-left selected cell (filling the selection when it is a multiple of
   * the pasted block), one `setCell` per cell. Read-only cells and values `setCell` rejects keep
   * their old value; one notice sums them up.
   */
  function onGridPaste(e: ClipboardEvent<HTMLDivElement>) {
    if (!isCellClipboardEvent(e) || !selection) return
    if (!Array.from(e.clipboardData.types ?? []).includes('text/plain')) return
    e.preventDefault()
    const plan = planPaste(parseTsv(e.clipboardData.getData('text/plain')), selection, rows.length, columns.length)
    const rejected: Rejection[] = []
    // One reschedule for the whole paste instead of one per cell.
    api.getState().batch(() => {
      for (const { row: r, col: c, value } of plan.cells) {
        const row = rows[r]
        const col = columns[c]
        const where = `row ${row.rowNumber} ${col.title}`
        if (!isEditable(col, row)) {
          // Pasting a block back over itself is not an error for its calculated cells.
          if (value !== copyText(col, row)) rejected.push({ where, reason: readOnlyReason(col, row) ?? 'read-only' })
          continue
        }
        if (value === editString(col, row) && !errorByCell.has(`${row.id}:${col.id}`)) continue
        const result = api.getState().setCell(row.id, col.id, value)
        if (!result.ok) rejected.push({ where, reason: result.error })
      }
    })
    notify(describeRejections(rejected, plan.clipped))
    // The pasted block becomes the selection; the active cell stays at its top-left.
    const { top, left, bottom, right } = plan.range
    setActive({ rowId: rows[top].id, colId: columns[left].id })
    setAnchor(rangeSize(plan.range) > 1 ? { rowId: rows[bottom].id, colId: columns[right].id } : null)
  }

  /** Clears every editable cell in the range; read-only cells are skipped silently. */
  function clearCells(range: CellRange, verb = 'cleared') {
    const rejected: Rejection[] = []
    api.getState().batch(() => {
      for (const { row: r, col: c } of rangeCells(range)) {
        const row = rows[r]
        const col = columns[c]
        if (!isEditable(col, row)) continue
        const empty = col.type === 'CHECKBOX' ? row.record.cells[col.id] !== true : editString(col, row) === ''
        if (empty && !errorByCell.has(`${row.id}:${col.id}`)) continue
        const result = api.getState().setCell(row.id, col.id, '')
        if (!result.ok) rejected.push({ where: `row ${row.rowNumber} ${col.title}`, reason: result.error })
      }
    })
    notify(describeRejections(rejected, 0, verb))
  }

  /** Adds a notice to the sheet's notice list (shown, dismissable, next to the save status). */
  function notify(message: string | null) {
    if (message) api.setState({ notices: [...api.getState().notices, message] })
  }

  /** Shift+mousedown extends the selection to the cell (and keeps focus from moving there by itself). */
  function onCellMouseDown(e: MouseEvent<HTMLDivElement>, rowId: string, colId: string) {
    if (!e.shiftKey || e.button !== 0 || editing || !active) return
    e.preventDefault()
    extendedByMouse.current = true
    select(rowId, colId, true, true)
  }

  /** Collapsing a row that holds the active cell moves the active cell up to that row. */
  function toggleRow(row: ViewRow) {
    if (row.expanded && !filterActive && active && isDescendant(parentOf, row.id, active.rowId)) {
      focusRequest.current = scrollRef.current?.contains(document.activeElement) ?? false
      setActive({ rowId: row.id, colId: active.colId })
      setEditing(false)
    }
    toggleCollapsed(row.id)
  }

  function shiftActiveRow(dir: 'indent' | 'outdent') {
    if (!activeValid) return
    const id = rows[activeRowIdx].id
    if (dir === 'indent') {
      api.getState().indentRow(id)
      // Expand the new parent so the indented row (and the active cell) stays visible.
      const parentId = api.getState().data?.rows.find((r) => r.id === id)?.parentId
      if (parentId) expand(parentId)
    } else api.getState().outdentRow(id)
  }

  /** Ids of all descendants of a row (any depth). */
  function descendantsOf(id: string): string[] {
    const children = new Map<string, string[]>()
    for (const r of data?.rows ?? []) {
      if (r.parentId === null) continue
      const list = children.get(r.parentId) ?? []
      list.push(r.id)
      children.set(r.parentId, list)
    }
    const out: string[] = []
    const seen = new Set([id])
    for (let stack = [...(children.get(id) ?? [])]; stack.length > 0; ) {
      const c = stack.pop()!
      if (seen.has(c)) continue
      seen.add(c)
      out.push(c)
      stack.push(...(children.get(c) ?? []))
    }
    return out
  }

  /** Delete row (toolbar or Delete key): a leaf goes at once, a parent asks first. */
  function requestDelete() {
    if (!activeValid) return
    const id = rows[activeRowIdx].id
    const subRows = descendantsOf(id).length
    if (subRows > 0) setPendingDelete({ rowId: id, subRows })
    else deleteRow(id)
  }

  /** Deletes a row and its sub-rows; the active cell moves to the next remaining row, else the previous. */
  function deleteRow(id: string) {
    const removed = new Set([id, ...descendantsOf(id)])
    const idx = rowIndex.get(id) ?? -1
    const neighbour =
      rows.slice(idx + 1).find((r) => !removed.has(r.id)) ??
      rows
        .slice(0, Math.max(0, idx))
        .reverse()
        .find((r) => !removed.has(r.id))
    const colId = active?.colId
    setPendingDelete(null)
    api.getState().deleteRow(id)
    if (neighbour && colId) select(neighbour.id, colId, true)
    else {
      setActive(null)
      setEditing(false)
    }
  }

  function addRow() {
    const last = allRows[allRows.length - 1]
    if (last) api.getState().addRow(last.id)
    else api.getState().addRow()
  }

  // Exactly one cell is in the tab order: the active cell when it is rendered, otherwise the
  // first cell of the first rendered row, so keyboard users can always tab into the grid.
  const virtualItems = virtualizer.getVirtualItems()
  const renderedIds = virtualItems.map((item) => rows[item.index]?.id)
  const activeRendered = activeValid && renderedIds.includes(active!.rowId)
  const firstRenderedRowId = renderedIds[0]

  function renderCell(row: ViewRow, col: Column, idx: number) {
    const key = `${row.id}:${col.id}`
    // A validation error from the last edit wins; otherwise a formula that fails to evaluate.
    const error = errorByCell.get(key) ?? formulaError(col, row)
    const isActive = active?.rowId === row.id && active.colId === col.id
    const inSelection = multiSelected && rangeContains(selection!, rowIndex.get(row.id) ?? -1, idx)
    const editable = isEditable(col, row)
    const errorId = error ? `cell-error-${row.id}-${col.id}` : undefined
    const initial = editString(col, row)
    let content
    if (isActive && editing && editable) {
      content = (
        <CellEditor
          column={col}
          initial={initial}
          onCommit={(raw, reason) => commit(row.id, col.id, raw, reason, initial)}
          onCancel={cancel}
        />
      )
    } else if (col.type === 'CHECKBOX') {
      content = (
        <CheckboxCell
          column={col}
          rowNumber={row.rowNumber}
          checked={row.record.cells[col.id] === true}
          onCommit={(raw) => api.getState().setCell(row.id, col.id, raw)}
        />
      )
    } else if (col.role === 'predecessor') {
      content = <PredecessorCell rowId={row.id} text={row.predecessors} />
    } else {
      content = <span className="cell-text">{displayText(col, row)}</span>
    }
    if (idx === 0) {
      content = (
        <HierarchyCell
          depth={row.depth}
          hasChildren={row.hasChildren}
          expanded={row.expanded}
          name={displayText(col, row) || `row ${row.rowNumber}`}
          onToggle={() => toggleRow(row)}
        >
          {content}
        </HierarchyCell>
      )
    }
    return (
      <div
        key={col.id}
        role="gridcell"
        className={`grid-cell${isActive ? ' is-active' : ''}${inSelection ? ' is-selected' : ''}${error ? ' has-error' : ''}${editable ? '' : ' is-readonly'}`}
        style={{ width: widthOf(col.id) }}
        aria-colindex={idx + 2}
        aria-selected={isActive || inSelection}
        aria-readonly={editable ? undefined : true}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        title={error ?? readOnlyReason(col, row)}
        tabIndex={isActive || (!activeRendered && row.id === firstRenderedRowId && idx === 0) ? 0 : -1}
        data-row-id={row.id}
        data-col-id={col.id}
        onMouseDown={(e) => onCellMouseDown(e, row.id, col.id)}
        onClick={() => {
          if (extendedByMouse.current) {
            extendedByMouse.current = false
            return
          }
          if (!(isActive && editing)) select(row.id, col.id, false)
        }}
        onDoubleClick={() => {
          // A checkbox already toggled once per click of the double-click.
          if (col.type !== 'CHECKBOX') startEdit(row, col)
        }}
        onFocus={() => {
          // Focus arriving by Tab (or any other way) makes this the active cell.
          if (!isActive) select(row.id, col.id, false)
        }}
      >
        {content}
        {error && (
          <span id={errorId} className="visually-hidden">
            {error}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="grid-view">
      <div
        ref={scrollRef}
        className="grid-scroll"
        style={viewportHeight !== undefined ? { height: viewportHeight } : undefined}
      >
        <div
          role="grid"
          aria-rowcount={rows.length + 1}
          aria-colcount={columns.length + 1}
          aria-multiselectable
          className="grid"
          style={{ width: totalWidth }}
          onKeyDown={onGridKeyDown}
          onCopy={(e) => onGridCopy(e)}
          onCut={(e) => onGridCopy(e, true)}
          onPaste={onGridPaste}
        >
          <div role="row" aria-rowindex={1} className="grid-header" style={{ height: ROW_HEIGHT }}>
            {headers.map((h, i) => (
              <div
                key={h.id}
                role="columnheader"
                aria-colindex={i + 1}
                aria-sort={h.id === ROW_NUMBER_COLUMN_ID ? undefined : view.sort?.colId === h.id ? ARIA_SORT[view.sort.dir] : 'none'}
                className={`grid-header-cell${columnUi.renameField(h.id) ? ' is-renaming' : ''}`}
                style={{ width: h.getSize() }}
              >
                {h.id === ROW_NUMBER_COLUMN_ID ? (
                  <table.FlexRender header={h} />
                ) : (columnUi.renameField(h.id) ?? (
                  // Out of the tab order: the grid keeps a single tab stop.
                  <button type="button" className="sort-button" tabIndex={-1} onClick={() => cycleSort(h.id)}>
                    <table.FlexRender header={h} />
                  </button>
                ))}
                {h.id !== ROW_NUMBER_COLUMN_ID && columnUi.menuButton(h.id)}
                {h.column.getCanResize() && (
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${String(h.column.columnDef.header ?? '')}`}
                    className={`col-resizer${h.column.getIsResizing() ? ' is-resizing' : ''}`}
                    onMouseDown={h.getResizeHandler()}
                    onTouchStart={h.getResizeHandler()}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="grid-body" style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((item) => {
              const row = rows[item.index]
              return (
                <div
                  key={row.id}
                  role="row"
                  aria-rowindex={item.index + 2}
                  aria-level={row.depth + 1}
                  aria-expanded={row.hasChildren ? row.expanded : undefined}
                  className={`grid-row${row.isParent ? ' is-parent' : ''}${rowDrag.overId === row.id ? ' is-drop-target' : ''}`}
                  style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
                  {...rowDrag.rowProps(row.id)}
                >
                  <div
                    role="rowheader"
                    aria-colindex={1}
                    className="grid-cell row-number"
                    style={{ width: widthOf(ROW_NUMBER_COLUMN_ID) }}
                    {...rowDrag.handleProps(row.id)}
                  >
                    {row.rowNumber}
                    {row.scheduleError && (
                      <span role="img" className="sched-warning" aria-label={row.scheduleError} title={row.scheduleError}>
                        ⚠
                      </span>
                    )}
                  </div>
                  {columns.map((col, idx) => renderCell(row, col, idx))}
                </div>
              )
            })}
          </div>
        </div>
        {columnUi.addColumnButton}
        {rows.length === 0 && <p className="grid-empty">No rows yet</p>}
      </div>
      <div className="grid-toolbar">
        <button type="button" onClick={addRow}>
          Add row
        </button>
        <button type="button" disabled={!activeValid} onClick={() => shiftActiveRow('indent')}>
          Indent
        </button>
        <button type="button" disabled={!activeValid} onClick={() => shiftActiveRow('outdent')}>
          Outdent
        </button>
        <button type="button" disabled={!activeValid} onClick={requestDelete}>
          Delete row
        </button>
        <FilterBar columns={columns} filter={view.filter} onChange={setFilter} />
      </div>
      {pendingDelete && (
        <ConfirmDialog
          title="Delete row"
          message={`Delete this row and its ${pendingDelete.subRows} sub-row${pendingDelete.subRows === 1 ? '' : 's'}?`}
          confirmLabel="Delete"
          onConfirm={() => deleteRow(pendingDelete.rowId)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {columnUi.dialogs}
    </div>
  )
}

const clamp = (i: number, length: number) => Math.max(0, Math.min(length - 1, i))
