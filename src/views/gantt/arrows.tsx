import { useId } from 'react'
import type { SchedDep } from '../../engine/schedule'

/** Length of the straight stub where an arrow leaves or enters a bar. */
const GAP = 8
const ROW_HALF = 16

export interface BarEdges {
  left: number
  right: number
  /** Vertical centre of the row. */
  y: number
}

/** A point on a bar edge plus the horizontal direction the line travels there (+1 right, -1 left). */
interface Anchor {
  x: number
  y: number
  dir: 1 | -1
}

/** FS: end -> start, SS: start -> start, FF: end -> end, SF: start -> end. */
export function anchors(type: SchedDep['type'], from: BarEdges, to: BarEdges): { a: Anchor; b: Anchor } {
  const fromEnd = type === 'FS' || type === 'FF'
  const toEnd = type === 'FF' || type === 'SF'
  return {
    // Leave a right edge going right, a left edge going left.
    a: fromEnd ? { x: from.right, y: from.y, dir: 1 } : { x: from.left, y: from.y, dir: -1 },
    // Enter a left edge travelling right, a right edge travelling left.
    b: toEnd ? { x: to.right, y: to.y, dir: -1 } : { x: to.left, y: to.y, dir: 1 },
  }
}

/** Orthogonal elbow path from a to b; starts with `M a.x a.y` and ends with `H b.x`. */
export function elbowPath(a: Anchor, b: Anchor): string {
  const out = a.x + a.dir * GAP
  const into = b.x - b.dir * GAP
  // Three segments when one vertical line can serve both the exit and the entry stub.
  if ((b.x - out) * b.dir >= GAP) return `M ${a.x} ${a.y} H ${out} V ${b.y} H ${b.x}`
  if ((into - a.x) * a.dir >= GAP) return `M ${a.x} ${a.y} H ${into} V ${b.y} H ${b.x}`
  // Otherwise loop around through the gap between the two rows.
  const mid = b.y === a.y ? a.y + ROW_HALF : b.y + (b.y > a.y ? -ROW_HALF : ROW_HALF)
  return `M ${a.x} ${a.y} H ${out} V ${mid} H ${into} V ${b.y} H ${b.x}`
}

interface DependencyArrowsProps {
  deps: SchedDep[]
  /** Edges of a drawable row's bar, or null when the row is unscheduled or hidden. */
  edgesOf(rowId: string): BarEdges | null
  /** True when the row lies in the rendered (virtual) window. */
  inWindow(rowId: string): boolean
  rowNumber(rowId: string): number | undefined
  /** `depKey(pred, succ)` of the links to draw as critical. */
  criticalKeys?: ReadonlySet<string>
}

/** Dependency arrows, drawn under the bars and never intercepting their pointer events. */
export function DependencyArrows({ deps, edgesOf, inWindow, rowNumber, criticalKeys }: DependencyArrowsProps) {
  const markerId = `gantt-arrowhead-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const criticalMarkerId = `${markerId}-critical`
  return (
    <g className="gantt-arrows" pointerEvents="none">
      <defs>
        <marker id={markerId} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M 0 0 L 8 4 L 0 8 z" className="gantt-arrowhead" />
        </marker>
        {criticalKeys && criticalKeys.size > 0 && (
          <marker id={criticalMarkerId} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" className="gantt-arrowhead is-critical" />
          </marker>
        )}
      </defs>
      {deps.map((d) => {
        if (!inWindow(d.predecessorId) && !inWindow(d.successorId)) return null
        const from = edgesOf(d.predecessorId)
        const to = edgesOf(d.successorId)
        if (!from || !to) return null
        const { a, b } = anchors(d.type, from, to)
        const critical = criticalKeys?.has(`${d.predecessorId}->${d.successorId}`) ?? false
        const label = `Row ${rowNumber(d.predecessorId)} to Row ${rowNumber(d.successorId)} (${d.type})${critical ? ', critical' : ''}`
        return (
          <path
            key={`${d.predecessorId}|${d.successorId}`}
            data-testid="dep-arrow"
            data-dep-type={d.type}
            role="img"
            aria-label={label}
            data-critical={critical ? 'true' : undefined}
            className={critical ? 'gantt-arrow is-critical' : 'gantt-arrow'}
            d={elbowPath(a, b)}
            markerEnd={`url(#${critical ? criticalMarkerId : markerId})`}
          />
        )
      })}
    </g>
  )
}
