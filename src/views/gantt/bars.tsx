import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Scheduled } from '../../engine/schedule'
import type { DragMode } from './useBarDrag'

export const ROW_HEIGHT = 32
export const BAR_HEIGHT = 16
const SUMMARY_HEIGHT = 8
const HANDLE_WIDTH = 6

export type BarKind = 'task' | 'milestone' | 'summary'

export function barKind(s: Scheduled, isParent: boolean): BarKind {
  if (isParent) return 'summary'
  return s.durationDays === 0 ? 'milestone' : 'task'
}

export function barLabel(name: string, s: Scheduled, kind: BarKind, floatNote?: string): string {
  const note = floatNote ? `. ${floatNote}` : ''
  if (kind === 'milestone') return `${name}: milestone on ${s.start}${note}`
  const days = `${s.durationDays} ${s.durationDays === 1 ? 'day' : 'days'}`
  return `${name}: ${s.start} to ${s.end}, ${days}, ${s.percentComplete}% complete${note}`
}

interface GanttBarProps {
  rowId: string
  name: string
  kind: BarKind
  /** The dates to draw (the store's schedule, or the drag preview). */
  sched: Scheduled
  /** Horizontal extent from `barGeometry`. */
  x: number
  width: number
  /** Top of the row, in timeline coordinates. */
  rowTop: number
  dragging: boolean
  /** Critical-path view: drawn in the critical colour. */
  critical?: boolean
  /** Critical-path view: the float sentence added to the bar's label and tooltip. */
  floatNote?: string
  onPointerDown(e: ReactPointerEvent, rowId: string, mode: DragMode): void
}

const clampPct = (p: number) => Math.min(100, Math.max(0, p))

/** One row's bar: a task bar, a milestone diamond or a summary bracket, with progress overlay. */
export function GanttBar({ rowId, name, kind, sched, x, width, rowTop, dragging, critical, floatNote, onPointerDown }: GanttBarProps) {
  const label = barLabel(name, sched, kind, floatNote)
  const move = (e: ReactPointerEvent) => onPointerDown(e, rowId, 'move')
  const cls = `gantt-bar is-${kind}${dragging ? ' is-dragging' : ''}${critical ? ' is-critical' : ''}`
  const progress = (width * clampPct(sched.percentComplete)) / 100

  if (kind === 'milestone') {
    const cx = x + width / 2
    const cy = rowTop + ROW_HEIGHT / 2
    const h = width / 2
    return (
      <g role="img" aria-label={label} data-kind={kind} data-row-id={rowId} className={cls}>
        <title>{label}</title>
        <polygon
          className="gantt-bar-body"
          points={`${cx},${cy - h} ${cx + h},${cy} ${cx},${cy + h} ${cx - h},${cy}`}
          onPointerDown={move}
        />
      </g>
    )
  }

  if (kind === 'summary') {
    const y = rowTop + (ROW_HEIGHT - SUMMARY_HEIGHT) / 2
    const tip = 5
    const bottom = y + SUMMARY_HEIGHT
    return (
      <g role="img" aria-label={label} data-kind={kind} data-row-id={rowId} className={cls}>
        <title>{label}</title>
        <rect className="gantt-bar-body" x={x} y={y} width={width} height={SUMMARY_HEIGHT} onPointerDown={move} />
        <rect className="gantt-bar-progress" x={x} y={y} width={progress} height={SUMMARY_HEIGHT} pointerEvents="none" />
        <polygon className="gantt-summary-tip" points={`${x},${bottom} ${x + tip},${bottom} ${x},${bottom + tip}`} />
        <polygon
          className="gantt-summary-tip"
          points={`${x + width},${bottom} ${x + width - tip},${bottom} ${x + width},${bottom + tip}`}
        />
      </g>
    )
  }

  const y = rowTop + (ROW_HEIGHT - BAR_HEIGHT) / 2
  return (
    <g role="img" aria-label={label} data-kind={kind} data-row-id={rowId} className={cls}>
      <title>{label}</title>
      <rect className="gantt-bar-body" x={x} y={y} width={width} height={BAR_HEIGHT} rx={3} onPointerDown={move} />
      <rect className="gantt-bar-progress" x={x} y={y} width={progress} height={BAR_HEIGHT} rx={3} pointerEvents="none" />
      <rect
        className="gantt-bar-handle"
        x={x + width - HANDLE_WIDTH}
        y={y}
        width={HANDLE_WIDTH}
        height={BAR_HEIGHT}
        onPointerDown={(e) => onPointerDown(e, rowId, 'resize')}
      />
    </g>
  )
}
