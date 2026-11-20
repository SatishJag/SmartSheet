import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ActionResult } from '../store/sheetStore'
import { fixedViewport, measuredViewport } from '../views/grid/viewport'
import { AssetIcon } from './AssetIcon'
import { resolveWriteBack, SHEET_KEY, type ReportGroup, type ReportResult, type ReportRow, type ResolvedColumn, type SummaryValue } from './reportEngine'
import type { ReportDefinition, SourceSheet } from './types'
import { formatValue } from './values'

const ROW_H = 42
const MIN_COL = 150

type Item =
  | { kind: 'group'; group: ReportGroup; depth: number; open: boolean }
  | { kind: 'row'; row: ReportRow; depth: number }

function flatten(result: ReportResult, collapsed: ReadonlySet<string>, limit: number): Item[] {
  const items: Item[] = []
  let rows = 0
  const walk = (groups: ReportGroup[], depth: number) => {
    for (const g of groups) {
      const open = !collapsed.has(g.id)
      items.push({ kind: 'group', group: g, depth, open })
      if (!open) continue
      if (g.groups) walk(g.groups, depth + 1)
      else for (const row of g.rows ?? []) if (rows++ < limit) items.push({ kind: 'row', row, depth: depth + 1 })
    }
  }
  if (result.groups) walk(result.groups, 0)
  else for (const row of result.rows) if (rows++ < limit) items.push({ kind: 'row', row, depth: 0 })
  return items
}

const summaryText = (v: SummaryValue | undefined, type: ResolvedColumn['type']) =>
  v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : formatValue(v, type)

export interface ReportTableProps {
  result: ReportResult
  definition: ReportDefinition
  sheets: ReadonlyMap<string, SourceSheet>
  /** Edits a cell of a source sheet; when absent the table is read-only. */
  onEdit?: (sheetId: string, rowId: string, colId: string, raw: string) => ActionResult
  onOpenSheet?: (sheetId: string) => void
  /** Fixed viewport height in px (tests and previews); by default the table fills its box. */
  viewportHeight?: number
  /** Show at most this many data rows (the builder's preview). */
  maxRows?: number
  /** Name for assistive technology. */
  label: string
}

/**
 * The rows of a report as a virtualized grid: grouped rows collapse, summaries sit under their columns,
 * and (in the run view) a cell can be edited in place: a click opens the editor, Enter or blur saves
 * through the SOURCE sheet, Escape cancels. A cell the source sheet would not let you edit says why.
 */
export function ReportTable({ result, definition, sheets, onEdit, onOpenSheet, viewportHeight, maxRows = Infinity, label }: ReportTableProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const items = useMemo(() => flatten(result, collapsed, maxRows), [result, collapsed, maxRows])
  const cols = result.columns
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
    getItemKey: (i) => (items[i].kind === 'row' ? items[i].row.id : (items[i] as { group: ReportGroup }).group.id),
    ...(viewportHeight !== undefined ? fixedViewport(viewportHeight) : measuredViewport),
  })

  const [active, setActive] = useState<{ i: number; c: number } | null>(null)
  const [editing, setEditing] = useState<{ rowId: string; key: string } | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const focusNext = useRef(false)

  // Keep the keyboard position inside the table when rows disappear (a group collapses, data changes).
  useEffect(() => {
    setActive((a) => (a && a.i >= items.length ? (items.length > 0 ? { i: items.length - 1, c: a.c } : null) : a))
  }, [items.length])

  useEffect(() => {
    if (!focusNext.current || !active) return
    focusNext.current = false
    scrollRef.current?.querySelector<HTMLElement>(`[data-i="${active.i}"][data-c="${active.c}"]`)?.focus({ preventScroll: true })
  })

  // A column whose shown values are all numbers lines up on the right, header included.
  const numeric = useMemo(() => {
    const sample = result.rows.slice(0, 300)
    return new Set(
      cols
        .filter((c) => c.type === 'TEXT_NUMBER' && !c.virtual && sample.some((r) => typeof r.values[c.key] === 'number') && sample.every((r) => r.values[c.key] == null || typeof r.values[c.key] === 'number'))
        .map((c) => c.key),
    )
  }, [cols, result.rows])
  const summaryKeys = new Set(definition.summaries.map((s) => s.column))
  const hasTotals = summaryKeys.size > 0
  const width = Math.max(cols.length, 1) * MIN_COL
  const gridStyle = { '--cols': `repeat(${Math.max(cols.length, 1)}, minmax(${MIN_COL}px, 1fr))`, minWidth: width } as CSSProperties

  function targetOf(row: ReportRow, key: string) {
    return resolveWriteBack(result, sheets, row, key)
  }

  function startEdit(row: ReportRow, col: ResolvedColumn) {
    if (!onEdit) return
    const t = targetOf(row, col.key)
    setError(null)
    if (!t.ok) return
    if (col.type === 'CHECKBOX') {
      const current = row.values[col.key] === true
      const r = onEdit(t.sheetId, t.rowId, t.colId, current ? 'false' : 'true')
      if (!r.ok) setError(`${col.title}: ${r.error}`)
      return
    }
    setDraft(sheets.get(row.sheetId)?.rawText?.(row.rowId, t.colId) ?? formatValue(row.values[col.key], col.type))
    setEditing({ rowId: row.id, key: col.key })
  }

  function commit(row: ReportRow, col: ResolvedColumn): boolean {
    const t = targetOf(row, col.key)
    if (!t.ok || !onEdit) {
      setEditing(null)
      return true
    }
    const current = sheets.get(row.sheetId)?.rawText?.(row.rowId, t.colId) ?? ''
    if (draft === current) {
      setEditing(null)
      return true
    }
    const r = onEdit(t.sheetId, t.rowId, t.colId, draft)
    if (r.ok) {
      setEditing(null)
      setError(null)
      return true
    }
    setError(`${col.title} (${row.sheetName}, row ${row.rowNumber}): ${r.error}`)
    return false
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (editing) return
    const move = (i: number, c: number) => {
      e.preventDefault()
      const ni = Math.max(0, Math.min(items.length - 1, i))
      const nc = Math.max(0, Math.min(cols.length - 1, c))
      focusNext.current = true
      virtualizer.scrollToIndex(ni)
      setActive({ i: ni, c: nc })
    }
    const here = active ?? { i: 0, c: 0 }
    const item = items[here.i]
    switch (e.key) {
      case 'ArrowDown':
        return move(here.i + 1, here.c)
      case 'ArrowUp':
        return move(here.i - 1, here.c)
      case 'ArrowRight':
        return move(here.i, here.c + 1)
      case 'ArrowLeft':
        return move(here.i, here.c - 1)
      case 'Home':
        return move(here.i, 0)
      case 'End':
        return move(here.i, cols.length - 1)
      case 'PageDown':
        return move(here.i + 10, here.c)
      case 'PageUp':
        return move(here.i - 10, here.c)
      case 'Enter':
      case 'F2':
      case ' ':
        if (!item) return
        e.preventDefault()
        if (item.kind === 'group') toggle(item.group.id)
        else if (cols[here.c]) startEdit(item.row, cols[here.c])
    }
  }

  function toggle(id: string) {
    setCollapsed((s) => {
      const next = new Set(s)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  const virtual = virtualizer.getVirtualItems()

  return (
    <div className="rt-wrap">
      {error && (
        <p role="alert" className="rt-error">
          {error}
          <button type="button" className="btn-icon" aria-label="Dismiss error" onClick={() => setError(null)}>
            <AssetIcon name="close" size={16} />
          </button>
        </p>
      )}
      <div
        ref={scrollRef}
        className="rt-scroll"
        style={viewportHeight !== undefined ? { height: viewportHeight } : undefined}
        role="grid"
        aria-label={label}
        aria-rowcount={items.length + 1}
        aria-colcount={cols.length}
        tabIndex={active ? -1 : 0}
        onKeyDown={onKeyDown}
      >
        <div className="rt-head" role="row" aria-rowindex={1} style={gridStyle}>
          {cols.map((c, ci) => (
            <div key={c.key} role="columnheader" aria-colindex={ci + 1} className={`rt-cell${ci === 0 ? ' is-sticky' : ''}`} data-numeric={numeric.has(c.key) ? '' : undefined} title={c.title}>
              {c.title}
              {c.sheetCount === 0 && <span className="rt-missing"> (missing)</span>}
            </div>
          ))}
        </div>
        <div className="rt-body" style={{ height: virtualizer.getTotalSize(), ...gridStyle }}>
          {virtual.map((v) => {
            const item = items[v.index]
            if (!item) return null
            const style = { transform: `translateY(${v.start}px)`, height: v.size } as CSSProperties
            if (item.kind === 'group') {
              const g = item.group
              return (
                <div key={v.key} role="row" aria-rowindex={v.index + 2} aria-expanded={item.open} className="rt-row rt-group" style={style}>
                  {cols.map((c, ci) => (
                    <div
                      key={c.key}
                      role="gridcell"
                      aria-colindex={ci + 1}
                      data-i={v.index}
                      data-c={ci}
                      tabIndex={active?.i === v.index && active.c === ci ? 0 : -1}
                      className={`rt-cell${ci === 0 ? ' is-sticky' : ''}`}
                      data-numeric={numeric.has(c.key) ? '' : undefined}
                      onFocus={() => setActive({ i: v.index, c: ci })}
                    >
                      {ci === 0 ? (
                        <button
                          type="button"
                          className="rt-toggle"
                          aria-label={`${item.open ? 'Collapse' : 'Expand'} ${g.label}`}
                          onClick={() => toggle(g.id)}
                          style={{ paddingLeft: item.depth * 14 }}
                        >
                          <AssetIcon name="chevron" size={14} style={{ transform: item.open ? 'rotate(90deg)' : undefined }} />
                          <strong>{g.label}</strong>
                          <span className="chip">{g.count}</span>
                        </button>
                      ) : summaryKeys.has(c.key) ? (
                        <span className="rt-summary">{summaryText(g.summaries[c.key], c.type)}</span>
                      ) : null}
                    </div>
                  ))}
                </div>
              )
            }
            const row = item.row
            return (
              <div key={v.key} role="row" aria-rowindex={v.index + 2} className="rt-row" style={style}>
                {cols.map((c, ci) => (
                  <Cell
                    key={c.key}
                    col={c}
                    ci={ci}
                    index={v.index}
                    row={row}
                    isActive={active?.i === v.index && active.c === ci}
                    numeric={numeric.has(c.key)}
                    indent={ci === 0 ? item.depth : 0}
                    editable={onEdit ? targetOf(row, c.key) : null}
                    editing={editing?.rowId === row.id && editing.key === c.key}
                    draft={draft}
                    setDraft={setDraft}
                    options={c.options}
                    onFocus={() => setActive({ i: v.index, c: ci })}
                    onStart={() => startEdit(row, c)}
                    onCommit={() => commit(row, c)}
                    onCancel={() => {
                      setEditing(null)
                      setError(null)
                    }}
                    onOpenSheet={onOpenSheet}
                  />
                ))}
              </div>
            )
          })}
        </div>
        {hasTotals && (
          <div className="rt-foot" role="row" style={gridStyle}>
            {cols.map((c, ci) => (
              <div key={c.key} role="gridcell" className={`rt-cell${ci === 0 ? ' is-sticky' : ''}`} data-numeric={numeric.has(c.key) ? '' : undefined}>
                {ci === 0 ? <strong>Total</strong> : summaryKeys.has(c.key) ? <span className="rt-summary">{summaryText(result.totals[c.key], c.type)}</span> : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface CellProps {
  col: ResolvedColumn
  ci: number
  index: number
  row: ReportRow
  isActive: boolean
  numeric: boolean
  indent: number
  /** Null in a read-only table, else whether (and where) this cell can be written. */
  editable: ReturnType<typeof resolveWriteBack> | null
  editing: boolean
  draft: string
  setDraft: (s: string) => void
  options: string[] | undefined
  onFocus: () => void
  onStart: () => void
  onCommit: () => boolean
  onCancel: () => void
  onOpenSheet?: (sheetId: string) => void
}

function Cell(p: CellProps) {
  const { col, row, editable } = p
  const value = row.values[col.key]
  const can = editable?.ok === true
  const base = {
    role: 'gridcell' as const,
    'aria-colindex': p.ci + 1,
    'data-i': p.index,
    'data-c': p.ci,
    tabIndex: p.isActive ? 0 : -1,
    onFocus: p.onFocus,
    className: `rt-cell${p.ci === 0 ? ' is-sticky' : ''}${can ? ' is-editable' : ''}`,
    'aria-readonly': editable ? !can : undefined,
    title: editable && !can ? (editable.ok ? undefined : editable.reason) : undefined,
  }

  if (p.editing) {
    const stop = (e: KeyboardEvent) => e.stopPropagation()
    const finish = (refocus: boolean) => {
      if (p.onCommit() && refocus) (document.querySelector(`[data-i="${p.index}"][data-c="${p.ci}"]`) as HTMLElement | null)?.focus()
    }
    const common = {
      'aria-label': `${col.title}, ${row.sheetName} row ${row.rowNumber}`,
      autoFocus: true,
      onBlur: () => void p.onCommit(),
      onKeyDown: (e: KeyboardEvent) => {
        stop(e)
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          p.onCancel()
          ;(document.querySelector(`[data-i="${p.index}"][data-c="${p.ci}"]`) as HTMLElement | null)?.focus()
        }
      },
    }
    const select = col.type === 'PICKLIST' && p.options
    return (
      <div {...base}>
        {select ? (
          <select {...common} value={p.draft} onChange={(e) => p.setDraft(e.target.value)}>
            <option value="" />
            {p.options!.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : (
          <input {...common} type={col.type === 'DATE' ? 'date' : 'text'} value={p.draft} onChange={(e) => p.setDraft(e.target.value)} />
        )}
      </div>
    )
  }

  let content
  if (col.key === SHEET_KEY) {
    content = (
      <button type="button" className="link-button" onClick={() => p.onOpenSheet?.(row.sheetId)} title={`Open ${row.sheetName}`}>
        {formatValue(value)}
      </button>
    )
  } else if (col.type === 'CHECKBOX') {
    content = (
      <span className={`rt-check${value === true ? ' is-on' : ''}`} role="img" aria-label={value === true ? 'Checked' : 'Not checked'}>
        {value === true && <AssetIcon name="check" size={14} strokeWidth={3} />}
      </span>
    )
  } else if (typeof value === 'number') {
    content = <span className="rt-num">{String(value)}</span>
  } else {
    content = formatValue(value, col.type)
  }
  const text = typeof value === 'string' ? value : undefined
  return (
    <div
      {...base}
      onClick={can ? p.onStart : undefined}
      onDoubleClick={undefined}
      style={p.indent ? { paddingLeft: 12 + p.indent * 14 } : undefined}
      data-numeric={p.numeric ? '' : undefined}
      title={base.title ?? text}
    >
      {content}
      {can && <span className="visually-hidden"> (editable)</span>}
    </div>
  )
}
