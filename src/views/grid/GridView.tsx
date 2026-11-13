import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { useTable } from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Column } from '../../model/validate'
import { useSheetStore, useSheetStoreApi } from '../../store/SheetStoreContext'
import { READ_ONLY_MESSAGE } from '../../store/sheetStore'
import { ConfirmDialog } from '../ConfirmDialog'
import { CellEditor, CheckboxCell, type CommitReason } from './cellEditors'
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
import { inBounds, mapPaste, parseTsv, rangeBounds, toTsv } from './selection'
import { useGridViewState } from './useGridViewState'
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
  const viewOnly = useSheetStore((s) => s.readOnly)

  const columns = data?.columns ?? EMPTY_COLUMNS
  const columnDefs = useMemo(() => buildColumnDefs(columns), [columns])
  const { view, toggleCollapsed, expand, cycleSort, setFilter } = useGridViewState()

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
  /** The other corner of a multi-cell selection; null when only the active cell is selected. */
  const [anchor, setAnchor] = useState<ActiveCell | null>(null)
  const [editing, setEditing] = useState(false)
  /** Result of the last paste or clear, announced to screen readers. */
  const [status, setStatus] = useState('')
  /** A parent row waiting for the user to confirm its deletion. */
  const [pendingDelete, setPendingDelete] = useState<{ rowId: string; subRows: number } | null>(null)
  /** Set when the active cell should take keyboard focus after the next render. */
  const focusRequest = useRef(false)

  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows])
  const colIndex = useMemo(() => new Map(columns.map((c, i) => [c.id, i])), [columns])
  const activeRowIdx = active ? rowIndex.get(active.rowId) : undefined
  const activeColIdx = active ? colIndex.get(active.colId) : undefined
  const activeValid = activeRowIdx !== undefined && activeColIdx !== undefined
  // The selected rectangle. An anchor whose row was filtered out or whose column is gone is ignored.
  const anchorRowIdx = anchor ? rowIndex.get(anchor.rowId) : undefined
  const anchorColIdx = anchor ? colIndex.get(anchor.colId) : undefined
  const range = activeValid
    ? rangeBounds({ r: anchorRowIdx ?? activeRowIdx, c: anchorColIdx ?? activeColIdx }, { r: activeRowIdx, c: activeColIdx })
    : null

  useEffect(() => {
    if (!focusRequest.current || !active || editing) return
    focusRequest.current = false
    const cells = scrollRef.current?.querySelectorAll<HTMLElement>('[role="gridcell"]') ?? []
    const el = Array.from(cells).find((c) => c.dataset.rowId === active.rowId && c.dataset.colId === active.colId)
    el?.focus()
  }, [active, editing])

  /** Makes a cell active; `extend` keeps the selection anchor so the range grows to this cell. */
  function select(rowId: string, colId: string, focus: boolean, extend = false) {
    focusRequest.current = focus
    setAnchor(extend ? (anchor ?? active) : null)
    setActive({ rowId, colId })
    setEditing(false)
  }

  function startEdit(row: GridRow, col: Column) {
    if (viewOnly || !isEditable(col, row)) return
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
      select(rows[r].id, columns[c].id, true, e.shiftKey)
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const first = e.key === 'Home'
      // Ctrl/Cmd+Home/End jump to the first/last row as well.
      const r = e.ctrlKey || e.metaKey ? (first ? 0 : rows.length - 1) : activeRowIdx
      virtualizer.scrollToIndex(r)
      select(rows[r].id, columns[first ? 0 : columns.length - 1].id, true, e.shiftKey)
    } else if (e.key === 'Escape' && anchor) {
      setAnchor(null)
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault()
      startEdit(rows[activeRowIdx], columns[activeColIdx])
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && isCellTarget(e)) {
      e.preventDefault()
      const { r0, r1, c0, c1 } = range!
      const targets = []
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) targets.push({ row: rows[r], col: columns[c], raw: '' })
      applyCells(targets, 'Cleared', 0)
    }
  }

  /** The event came from a grid cell itself, not from an editor or control inside one. */
  const isCellTarget = (e: { target: EventTarget }) => (e.target as HTMLElement).getAttribute('role') === 'gridcell'

  /**
   * Writes each raw string through the store's setCell, so validation, scheduling and read-only
   * rules apply. A cell that cannot take its value keeps the old one; one summary is announced.
   */
  // shortcut: one setCell (and reschedule) per cell, upgrade to a batch store action if big pastes feel slow.
  function applyCells(targets: { row: ViewRow; col: Column; raw: string }[], verb: string, clipped: number) {
    if (viewOnly) {
      setStatus(READ_ONLY_MESSAGE)
      return
    }
    let done = 0
    const skipped: string[] = []
    for (const { row, col, raw } of targets) {
      let problem: string | undefined
      if (!isEditable(col, row)) problem = readOnlyReason(col, row) ?? 'is calculated and cannot be edited'
      else {
        const result = api.getState().setCell(row.id, col.id, raw)
        if (!result.ok) problem = result.error
      }
      if (problem === undefined) done++
      else skipped.push(`row ${row.rowNumber} ${col.title}: ${problem}`)
    }
    let message = `${verb} ${done} cell${done === 1 ? '' : 's'}`
    if (skipped.length > 0) {
      const more = skipped.length > 3 ? `; and ${skipped.length - 3} more` : ''
      message += `, ${skipped.length} skipped: ${skipped.slice(0, 3).join('; ')}${more}`
    }
    if (clipped > 0) message += `, ${clipped} past the edge of the grid ignored`
    setStatus(message)
  }

  /** Ctrl/Cmd+C: the selected rectangle's displayed values as tab-separated text. */
  function onCopy(e: ClipboardEvent<HTMLDivElement>) {
    if (editing || !range || !isCellTarget(e)) return
    e.preventDefault()
    const lines: string[][] = []
    for (let r = range.r0; r <= range.r1; r++) {
      lines.push(columns.slice(range.c0, range.c1 + 1).map((col) => displayText(col, rows[r])))
    }
    e.clipboardData.setData('text/plain', toTsv(lines))
  }

  /** Ctrl/Cmd+V: pastes tab/newline separated text with its top-left cell at the active cell. */
  // shortcut: a single copied value is not repeated across a larger selection, upgrade if users ask for fill-on-paste.
  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    if (editing || !activeValid || !isCellTarget(e)) return
    e.preventDefault()
    const block = parseTsv(e.clipboardData.getData('text/plain'))
    const { cells, clipped } = mapPaste(block, { r: activeRowIdx, c: activeColIdx }, rows.length, columns.length)
    if (cells.length === 0) return
    applyCells(
      cells.map(({ r, c, raw }) => ({ row: rows[r], col: columns[c], raw })),
      'Pasted',
      clipped,
    )
    // Select what was pasted; the active cell stays at its top-left.
    const last = { r: Math.max(...cells.map((x) => x.r)), c: Math.max(...cells.map((x) => x.c)) }
    setAnchor(cells.length > 1 ? { rowId: rows[last.r].id, colId: columns[last.c].id } : null)
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

  function renderCell(row: ViewRow, col: Column, idx: number, rowIdx: number) {
    const key = `${row.id}:${col.id}`
    // A validation error from the last edit wins; otherwise a formula that fails to evaluate.
    const error = errorByCell.get(key) ?? formulaError(col, row)
    const isActive = active?.rowId === row.id && active.colId === col.id
    const isSelected = range !== null && inBounds(range, rowIdx, idx)
    const editable = !viewOnly && isEditable(col, row)
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
        className={`grid-cell${isActive ? ' is-active' : ''}${isSelected && !isActive ? ' is-selected' : ''}${error ? ' has-error' : ''}${editable ? '' : ' is-readonly'}`}
        style={{ width: widthOf(col.id) }}
        aria-colindex={idx + 2}
        aria-selected={isSelected}
        aria-readonly={editable ? undefined : true}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        title={error ?? readOnlyReason(col, row)}
        tabIndex={isActive || (!activeRendered && row.id === firstRenderedRowId && idx === 0) ? 0 : -1}
        data-row-id={row.id}
        data-col-id={col.id}
        // Shift+click must not move focus on mouse-down, or the focus handler would reset the anchor.
        onMouseDown={(e) => {
          if (e.shiftKey && !(isActive && editing)) e.preventDefault()
        }}
        onClick={(e) => {
          if (!(isActive && editing)) select(row.id, col.id, e.shiftKey, e.shiftKey)
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
          aria-multiselectable="true"
          className="grid"
          style={{ width: totalWidth }}
          onKeyDown={onGridKeyDown}
          onCopy={onCopy}
          onPaste={onPaste}
        >
          <div role="row" aria-rowindex={1} className="grid-header" style={{ height: ROW_HEIGHT }}>
            {headers.map((h, i) => (
              <div
                key={h.id}
                role="columnheader"
                aria-colindex={i + 1}
                aria-sort={h.id === ROW_NUMBER_COLUMN_ID ? undefined : view.sort?.colId === h.id ? ARIA_SORT[view.sort.dir] : 'none'}
                className="grid-header-cell"
                style={{ width: h.getSize() }}
              >
                {h.id === ROW_NUMBER_COLUMN_ID ? (
                  <table.FlexRender header={h} />
                ) : (
                  // Out of the tab order: the grid keeps a single tab stop.
                  <button type="button" className="sort-button" tabIndex={-1} onClick={() => cycleSort(h.id)}>
                    <table.FlexRender header={h} />
                  </button>
                )}
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
                  {columns.map((col, idx) => renderCell(row, col, idx, item.index))}
                </div>
              )
            })}
          </div>
        </div>
        {rows.length === 0 && <p className="grid-empty">No rows yet</p>}
      </div>
      <div className="grid-toolbar">
        <button type="button" disabled={viewOnly} onClick={addRow}>
          Add row
        </button>
        <button type="button" disabled={viewOnly || !activeValid} onClick={() => shiftActiveRow('indent')}>
          Indent
        </button>
        <button type="button" disabled={viewOnly || !activeValid} onClick={() => shiftActiveRow('outdent')}>
          Outdent
        </button>
        <button type="button" disabled={viewOnly || !activeValid} onClick={requestDelete}>
          Delete row
        </button>
        <FilterBar columns={columns} filter={view.filter} onChange={setFilter} />
      </div>
      <div role="status" className="visually-hidden">
        {status}
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
    </div>
  )
}

const clamp = (i: number, length: number) => Math.max(0, Math.min(length - 1, i))
