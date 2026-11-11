import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { isWorkingDay, shiftIso } from '../../engine/calendar'
import type { Scheduled } from '../../engine/schedule'
import type { Calendar } from '../../engine/types'
import { visibleOrder } from '../../model/hierarchy'
import type { SheetData } from '../../store/persistence'
import { rowNumbers } from '../../store/predecessors'
import { useSheetStore, useSheetStoreApi } from '../../store/SheetStoreContext'
import { fixedViewport, measuredViewport } from '../grid/viewport'
import { DependencyArrows, type BarEdges } from './arrows'
import { barKind, GanttBar, ROW_HEIGHT } from './bars'
import {
  barGeometry,
  capRange,
  computeRange,
  dayIndex,
  daysBetween,
  listDays,
  monthSegments,
  utcToday,
  workingDaysInclusive,
  type DayRange,
} from './timeScale'
import { useBarDrag, type DragMode, type DragPreview } from './useBarDrag'
import './gantt.css'

const LABEL_WIDTH = 240
const HEADER_ROW = 20
const INDENT_PX = 16
const OVERSCAN = 10

const MSG_PREDECESSORS = 'Start date is set by predecessors — edit the Predecessors column to move this task'
const MSG_SUMMARY = 'Summary row dates are calculated from their child rows — move the child tasks instead'
const MSG_NO_DURATION = 'Add a Duration column to resize tasks in the Gantt chart'

export interface GanttViewProps {
  /** Width of one calendar day in px. */
  dayWidth?: number
  /** Height of the scroll area in px. Measured from the layout when omitted. */
  viewportHeight?: number
  /** Today's date (ISO), for the today line. Defaults to the current UTC date. */
  today?: string
}

interface GanttRow {
  id: string
  name: string
  depth: number
  isParent: boolean
  error?: string
}

/** Rows in tree order, minus descendants of collapsed rows, with what the chart shows for each. */
function buildRows(data: SheetData, errors: Map<string, string>, collapsed: ReadonlySet<string>): GanttRow[] {
  const text = data.columns.filter((c) => c.type === 'TEXT_NUMBER')
  const labelCol = (text.find((c) => !c.role) ?? text[0])?.id
  const byId = new Map(data.rows.map((r) => [r.id, r]))
  const parents = new Set(data.rows.flatMap((r) => (r.parentId && byId.has(r.parentId) ? [r.parentId] : [])))
  const depthOf = (id: string): number => {
    let depth = 0
    for (let p = byId.get(id)?.parentId; p && byId.has(p) && depth < data.rows.length; p = byId.get(p)?.parentId) depth++
    return depth
  }
  return visibleOrder(data.rows, collapsed).map((id) => {
    const raw = labelCol ? byId.get(id)!.cells[labelCol] : undefined
    return { id, name: raw == null ? '' : String(raw), depth: depthOf(id), isParent: parents.has(id), error: errors.get(id) }
  })
}

/** The dates to draw for a row, with the drag preview applied. */
function previewed(s: Scheduled, p: DragPreview | null, rowId: string, cal: Calendar): Scheduled {
  if (!p || p.rowId !== rowId || p.days === 0) return s
  if (p.mode === 'move') return { ...s, start: shiftIso(s.start, p.days), end: shiftIso(s.end, p.days) }
  const proposed = shiftIso(s.end, p.days)
  const end = proposed < s.start ? s.start : proposed
  return { ...s, end, durationDays: Math.max(1, workingDaysInclusive(cal, s.start, end)) }
}

/**
 * Gantt chart of the sheet: a sticky label column, a date header and an SVG timeline with
 * bars, milestones, summary bars and dependency arrows. Rows are virtualized. Dragging a bar
 * writes the Start (move) or Duration (resize) cell through the store.
 */
export function GanttView({ dayWidth = 28, viewportHeight, today }: GanttViewProps) {
  const api = useSheetStoreApi()
  const data = useSheetStore((s) => s.data)
  const scheduled = useSheetStore((s) => s.scheduled)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [status, setStatus] = useState('')
  const todayIso = today ?? utcToday()

  const startCol = data?.columns.find((c) => c.role === 'start')?.id
  const durationCol = data?.columns.find((c) => c.role === 'duration')?.id
  const cal = data?.sheet.calendar

  const errorById = useMemo(() => new Map(scheduled.errors.map((e) => [e.rowId, e.message])), [scheduled.errors])
  const rows = useMemo(() => (data ? buildRows(data, errorById, collapsed) : []), [data, errorById, collapsed])
  const indexById = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows])
  const numbers = useMemo(() => (data ? rowNumbers(data) : new Map<string, number>()), [data])
  const driven = useMemo(
    () => new Set(data?.sheet.dependenciesEnabled ? data.dependencies.map((d) => d.successorId) : []),
    [data],
  )

  const drag = useBarDrag(dayWidth, (rowId, mode, delta) => {
    const s = api.getState().scheduled.byRow[rowId]
    if (!s || !cal) return
    let result
    if (mode === 'move') {
      result = api.getState().setCell(rowId, startCol!, shiftIso(s.start, delta))
    } else {
      const n = Math.max(1, workingDaysInclusive(cal, s.start, shiftIso(s.end, delta)))
      result = api.getState().setCell(rowId, durationCol!, `${n}d`)
    }
    setStatus(result.ok ? '' : result.error)
  })

  function startDrag(e: ReactPointerEvent, rowId: string, mode: DragMode) {
    const row = rows[indexById.get(rowId) ?? -1]
    let blocked: string | null = null
    if (row?.isParent) blocked = MSG_SUMMARY
    // Resizing writes only Duration, so a dependency-driven start does not block it.
    else if (mode === 'move' && driven.has(rowId)) blocked = MSG_PREDECESSORS
    else if (mode === 'resize' && !durationCol) blocked = MSG_NO_DURATION
    if (blocked) {
      e.preventDefault()
      setStatus(blocked)
      return
    }
    setStatus('')
    drag.start(e, rowId, mode)
  }

  // The timeline origin only ever moves earlier while mounted, so moving the earliest task does
  // not shift the whole chart under it. The drag preview counts too: a bar dragged past either
  // end extends the range instead of being clipped.
  const originRef = useRef<string | null>(null)
  const freshRange = useMemo(() => {
    const spans: { start: string; end: string }[] = Object.values(scheduled.byRow)
    const p = drag.preview
    const s = p && cal ? scheduled.byRow[p.rowId] : undefined
    if (p && s && cal) spans.push(previewed(s, p, p.rowId, cal))
    const fresh = computeRange(spans, todayIso)
    const prev = originRef.current
    const start = prev !== null && prev < fresh.start ? prev : fresh.start
    const end = shiftIso(fresh.start, fresh.days - 1)
    // A schedule spanning more than MAX_RANGE_DAYS is clipped to its earliest window.
    return capRange({ start, days: daysBetween(start, end) + 1, limited: fresh.limited })
  }, [scheduled.byRow, todayIso, drag.preview, cal])
  // Keep the range's identity while its value is unchanged so the header and shading stay memoized.
  const { start: rangeStart, days: rangeDays, limited } = freshRange
  const range = useMemo<DayRange>(() => ({ start: rangeStart, days: rangeDays }), [rangeStart, rangeDays])
  const days = useMemo(() => listDays(range), [range])
  const timelineWidth = range.days * dayWidth

  // The day header and non-working shading are the largest node sets (one per day): build them
  // only when the range, day width or calendar changes, not on every row/collapse/drag update.
  const dateHeader = useMemo(
    () =>
      cal ? (
        <svg className="gantt-dates" width={timelineWidth} height={2 * HEADER_ROW} aria-hidden="true">
          {monthSegments(range).map((m) => (
            <g key={m.label}>
              <rect className="gantt-month" x={m.startIndex * dayWidth} y={0} width={m.days * dayWidth} height={HEADER_ROW} />
              <text x={m.startIndex * dayWidth + 4} y={HEADER_ROW - 6}>
                {m.label}
              </text>
            </g>
          ))}
          {days.map((iso, i) => (
            <text
              key={iso}
              data-date={iso}
              className={isWorkingDay(cal, iso) ? 'gantt-day' : 'gantt-day is-nonworking'}
              x={i * dayWidth + dayWidth / 2}
              y={2 * HEADER_ROW - 6}
              textAnchor="middle"
            >
              {Number(iso.slice(8))}
            </text>
          ))}
        </svg>
      ) : null,
    [range, days, dayWidth, cal, timelineWidth],
  )
  const shading = useMemo(
    () =>
      cal ? (
        <g className="gantt-shading">
          {days.map((iso, i) =>
            isWorkingDay(cal, iso) ? null : (
              <rect
                key={iso}
                data-testid="nonworking-day"
                data-date={iso}
                className="gantt-nonworking"
                x={i * dayWidth}
                y={0}
                width={dayWidth}
                height="100%"
              />
            ),
          )}
        </g>
      ) : null,
    [days, dayWidth, cal],
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  // When the origin moves earlier, scroll by the same amount so nothing jumps on screen.
  useLayoutEffect(() => {
    const prev = originRef.current
    originRef.current = range.start
    const el = scrollRef.current
    if (prev !== null && el && prev !== range.start) el.scrollLeft += daysBetween(range.start, prev) * dayWidth
  }, [range.start, dayWidth])
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    scrollPaddingStart: 2 * HEADER_ROW,
    getItemKey: (i) => rows[i]?.id ?? i,
    ...(viewportHeight !== undefined ? fixedViewport(viewportHeight) : measuredViewport),
  })

  const statusRegion = (
    <div role="status" className="gantt-status">
      {status}
    </div>
  )
  if (!data || !cal) return null
  if (!startCol) {
    return (
      <section className="gantt" aria-label="Gantt chart">
        {statusRegion}
        <p className="gantt-empty">Add a Start column to see the Gantt chart</p>
      </section>
    )
  }
  if (rows.length === 0) {
    return (
      <section className="gantt" aria-label="Gantt chart">
        {statusRegion}
        <p className="gantt-empty">No scheduled tasks to display</p>
      </section>
    )
  }

  const items = virtualizer.getVirtualItems()
  const first = items[0]?.index ?? 0
  const last = items[items.length - 1]?.index ?? -1
  const totalHeight = virtualizer.getTotalSize()
  const todayIdx = dayIndex(range.start, todayIso)

  const shown = (rowId: string): Scheduled | null => {
    const s = scheduled.byRow[rowId]
    return s ? previewed(s, drag.preview, rowId, cal) : null
  }
  const edgesOf = (rowId: string): BarEdges | null => {
    const i = indexById.get(rowId)
    const s = shown(rowId)
    if (i === undefined || !s) return null
    const g = barGeometry(range.start, s, dayWidth)
    return { left: g.x, right: g.x + g.width, y: i * ROW_HEIGHT + ROW_HEIGHT / 2 }
  }
  const inWindow = (rowId: string) => {
    const i = indexById.get(rowId)
    return i !== undefined && i >= first && i <= last
  }
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  return (
    <section className="gantt" aria-label="Gantt chart">
      {statusRegion}
      {limited && (
        <p className="gantt-limit-note" role="note">
          Timeline limited to 10 years
        </p>
      )}
      <div ref={scrollRef} className="gantt-scroll" style={viewportHeight !== undefined ? { height: viewportHeight } : undefined}>
        <div className="gantt-inner" style={{ width: LABEL_WIDTH + timelineWidth }}>
          <div className="gantt-header" style={{ height: 2 * HEADER_ROW }}>
            <div className="gantt-corner" style={{ width: LABEL_WIDTH }}>
              Task
            </div>
            {dateHeader}
          </div>
          <div className="gantt-body" style={{ height: totalHeight }}>
            <div className="gantt-labels" style={{ width: LABEL_WIDTH, height: totalHeight }}>
              {items.map((item) => {
                const row = rows[item.index]
                const expanded = !collapsed.has(row.id)
                const name = row.name || `Row ${numbers.get(row.id)}`
                return (
                  <div
                    key={row.id}
                    className={`gantt-label${row.isParent ? ' is-parent' : ''}`}
                    style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)`, paddingLeft: 4 + row.depth * INDENT_PX }}
                  >
                    {row.isParent ? (
                      <button
                        type="button"
                        className="gantt-toggle"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
                        onClick={() => toggle(row.id)}
                      >
                        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                      </button>
                    ) : (
                      <span className="gantt-toggle-spacer" aria-hidden="true" />
                    )}
                    <span className="gantt-label-text">{row.name}</span>
                    {row.error && (
                      <span className="gantt-warning" role="img" aria-label={`Scheduling error: ${row.error}`} title={row.error}>
                        ⚠
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            <svg className="gantt-timeline" width={timelineWidth} height={totalHeight}>
              {shading}
              {todayIdx >= 0 && todayIdx < range.days && (
                <line
                  data-testid="today-line"
                  className="gantt-today"
                  x1={todayIdx * dayWidth + dayWidth / 2}
                  x2={todayIdx * dayWidth + dayWidth / 2}
                  y1={0}
                  y2={totalHeight}
                />
              )}
              <DependencyArrows
                deps={data.sheet.dependenciesEnabled ? data.dependencies : []}
                edgesOf={edgesOf}
                inWindow={inWindow}
                rowNumber={(id) => numbers.get(id)}
              />
              {items.map((item) => {
                const row = rows[item.index]
                const s = shown(row.id)
                if (!s) return null
                const g = barGeometry(range.start, s, dayWidth)
                return (
                  <GanttBar
                    key={row.id}
                    rowId={row.id}
                    name={row.name || `Row ${numbers.get(row.id)}`}
                    kind={barKind(s, row.isParent)}
                    sched={s}
                    x={g.x}
                    width={g.width}
                    rowTop={item.start}
                    dragging={drag.preview?.rowId === row.id}
                    onPointerDown={startDrag}
                  />
                )
              })}
            </svg>
          </div>
        </div>
      </div>
    </section>
  )
}
