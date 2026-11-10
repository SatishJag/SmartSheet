import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTable } from '@tanstack/react-table'
import { observeElementRect, useVirtualizer, type Rect, type Virtualizer } from '@tanstack/react-virtual'
import { fullOrder } from '../../model/hierarchy'
import type { Column } from '../../model/validate'
import { useSheetStore, useSheetStoreApi } from '../../store/SheetStoreContext'
import { CellEditor, CheckboxCell, type CommitReason } from './cellEditors'
import { buildColumnDefs, displayText, gridFeatures, isEditable, toEditString, type GridRow } from './columns'
import './grid.css'

export const ROW_HEIGHT = 32
const OVERSCAN = 10
const EMPTY_COLUMNS: Column[] = []

interface ActiveCell {
  rowId: string
  colId: string
}

export interface GridViewProps {
  /** Height of the scrollable grid in px. Measured from the layout when omitted. */
  viewportHeight?: number
}

/**
 * The sheet grid: rows in tree order, virtualized, one active cell at a time, typed editors.
 * Everything comes from the sheet store via context; edits go through `setCell`.
 */
export function GridView({ viewportHeight }: GridViewProps) {
  const api = useSheetStoreApi()
  const data = useSheetStore((s) => s.data)
  const scheduled = useSheetStore((s) => s.scheduled)
  const errors = useSheetStore((s) => s.errors)

  const columns = data?.columns ?? EMPTY_COLUMNS
  const columnDefs = useMemo(() => buildColumnDefs(columns), [columns])
  const rowRecords = data?.rows

  const rows = useMemo<GridRow[]>(() => {
    if (!rowRecords) return []
    const byId = new Map(rowRecords.map((r) => [r.id, r]))
    const parents = new Set(rowRecords.map((r) => r.parentId).filter((p) => p !== null))
    const schedErrors = new Map<string, string[]>()
    for (const e of scheduled.errors) schedErrors.set(e.rowId, [...(schedErrors.get(e.rowId) ?? []), e.message])
    return fullOrder(rowRecords).map((id, i) => ({
      id,
      rowNumber: i + 1,
      isParent: parents.has(id),
      record: byId.get(id)!,
      scheduled: scheduled.byRow[id],
      scheduleError: schedErrors.get(id)?.join('; ') ?? null,
    }))
  }, [rowRecords, scheduled])

  const errorByCell = useMemo(() => new Map(errors.map((e) => [`${e.rowId}:${e.colId}`, e.message])), [errors])

  const table = useTable({
    features: gridFeatures,
    columns: columnDefs,
    data: rows,
    columnResizeMode: 'onChange',
    getRowId: (r) => r.id,
  })
  const tableRows = table.getRowModel().rows
  const headers = table.getHeaderGroups()[0]?.headers ?? []
  const widthOf = (colId: string) => table.getColumn(colId)?.getSize() ?? 0
  const totalWidth = table.getTotalSize()

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    scrollPaddingStart: ROW_HEIGHT, // the sticky header covers the first row's height
    getItemKey: (i) => tableRows[i]?.id ?? i,
    ...(viewportHeight !== undefined ? fixedViewport(viewportHeight) : measuredViewport),
  })

  const [active, setActive] = useState<ActiveCell | null>(null)
  const [editing, setEditing] = useState(false)
  /** Set when the active cell should take keyboard focus after the next render. */
  const focusRequest = useRef(false)

  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows])
  const colIndex = useMemo(() => new Map(columns.map((c, i) => [c.id, i])), [columns])
  const activeRowIdx = active ? rowIndex.get(active.rowId) : undefined
  const activeColIdx = active ? colIndex.get(active.colId) : undefined
  const activeValid = activeRowIdx !== undefined && activeColIdx !== undefined

  useEffect(() => {
    if (!focusRequest.current || !active || editing) return
    focusRequest.current = false
    const cells = scrollRef.current?.querySelectorAll<HTMLElement>('[role="gridcell"]') ?? []
    const el = Array.from(cells).find((c) => c.dataset.rowId === active.rowId && c.dataset.colId === active.colId)
    el?.focus()
  }, [active, editing])

  function select(rowId: string, colId: string, focus: boolean) {
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

  function commit(rowId: string, colId: string, raw: string, reason: CommitReason) {
    api.getState().setCell(rowId, colId, raw)
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
    if (e.key in move) {
      e.preventDefault()
      const [dr, dc] = move[e.key]
      const r = clamp(activeRowIdx + dr, rows.length)
      const c = clamp(activeColIdx + dc, columns.length)
      virtualizer.scrollToIndex(r)
      select(rows[r].id, columns[c].id, true)
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault()
      startEdit(rows[activeRowIdx], columns[activeColIdx])
    }
  }

  function addRow() {
    const last = rows[rows.length - 1]
    if (last) api.getState().addRow(last.id)
    else api.getState().addRow()
  }

  // Exactly one cell is in the tab order: the active cell when it is rendered, otherwise the
  // first cell of the first rendered row, so keyboard users can always tab into the grid.
  const virtualItems = virtualizer.getVirtualItems()
  const renderedIds = virtualItems.map((item) => tableRows[item.index]?.id)
  const activeRendered = activeValid && renderedIds.includes(active!.rowId)
  const firstRenderedRowId = renderedIds[0]

  function renderCell(row: GridRow, col: Column, idx: number) {
    const key = `${row.id}:${col.id}`
    const error = errorByCell.get(key)
    const isActive = active?.rowId === row.id && active.colId === col.id
    const editable = isEditable(col, row)
    const errorId = error ? `cell-error-${row.id}-${col.id}` : undefined
    let content
    if (isActive && editing && editable) {
      content = (
        <CellEditor
          column={col}
          initial={toEditString(row.record.cells[col.id])}
          onCommit={(raw, reason) => commit(row.id, col.id, raw, reason)}
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
    } else {
      content = <span className="cell-text">{displayText(col, row)}</span>
    }
    return (
      <div
        key={col.id}
        role="gridcell"
        className={`grid-cell${isActive ? ' is-active' : ''}${error ? ' has-error' : ''}${editable ? '' : ' is-readonly'}`}
        style={{ width: widthOf(col.id) }}
        aria-colindex={idx + 2}
        aria-selected={isActive}
        aria-readonly={editable ? undefined : true}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        title={error}
        tabIndex={isActive || (!activeRendered && row.id === firstRenderedRowId && idx === 0) ? 0 : -1}
        data-row-id={row.id}
        data-col-id={col.id}
        onClick={() => {
          if (!(isActive && editing)) select(row.id, col.id, false)
        }}
        onDoubleClick={() => startEdit(row, col)}
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
          className="grid"
          style={{ width: totalWidth }}
          onKeyDown={onGridKeyDown}
        >
          <div role="row" aria-rowindex={1} className="grid-header" style={{ height: ROW_HEIGHT }}>
            {headers.map((h, i) => (
              <div
                key={h.id}
                role="columnheader"
                aria-colindex={i + 1}
                className="grid-header-cell"
                style={{ width: h.getSize() }}
              >
                <table.FlexRender header={h} />
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
              const row = tableRows[item.index].original
              return (
                <div
                  key={row.id}
                  role="row"
                  aria-rowindex={item.index + 2}
                  className={`grid-row${row.isParent ? ' is-parent' : ''}`}
                  style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
                >
                  <div role="rowheader" aria-colindex={1} className="grid-cell row-number" style={{ width: widthOf('__row') }}>
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
        {rows.length === 0 && <p className="grid-empty">No rows yet</p>}
      </div>
      <div className="grid-toolbar">
        <button type="button" onClick={addRow}>
          Add row
        </button>
      </div>
    </div>
  )
}

/** Height assumed when the scroll element reports none (no layout yet, or jsdom). */
const FALLBACK_VIEWPORT_HEIGHT = 600

/** Observe the real element size, but never report a zero height (which would render no rows). */
const measuredViewport = {
  observeElementRect: (instance: Virtualizer<HTMLDivElement, Element>, cb: (rect: Rect) => void) =>
    observeElementRect(instance, (rect) =>
      cb(rect.height > 0 ? rect : { width: rect.width, height: FALLBACK_VIEWPORT_HEIGHT }),
    ),
}

const clamp = (i: number, length: number) => Math.max(0, Math.min(length - 1, i))

/**
 * Virtualizer options for a known viewport height: the rect is fixed instead of observed,
 * which also lets jsdom (no layout) window the rows.
 */
function fixedViewport(height: number) {
  const rect: Rect = { width: 0, height }
  return {
    initialRect: rect,
    observeElementRect: (_instance: Virtualizer<HTMLDivElement, Element>, cb: (rect: Rect) => void) => {
      cb(rect)
      return () => {}
    },
  }
}
