import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

export type DragMode = 'move' | 'resize'

export interface DragPreview {
  rowId: string
  mode: DragMode
  /** Whole days the pointer has moved (rounded); negative is left. */
  days: number
}

/**
 * Horizontal bar dragging in whole days. `start` is called from a bar's pointerdown; the drag
 * then follows pointermove/pointerup on the window. Escape or pointercancel abandons it.
 * `onCommit` runs once on release, and only when the drag moved by at least one day.
 */
export function useBarDrag(dayWidth: number, onCommit: (rowId: string, mode: DragMode, days: number) => void) {
  const [preview, setPreview] = useState<DragPreview | null>(null)
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit
  const endRef = useRef<(() => void) | null>(null)

  useEffect(() => () => endRef.current?.(), [])

  const start = useCallback(
    (e: ReactPointerEvent, rowId: string, mode: DragMode) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      endRef.current?.()
      const x0 = e.clientX
      const daysAt = (x: number) => Math.round((x - x0) / dayWidth) || 0
      let days = 0

      const onMove = (ev: PointerEvent) => {
        const d = daysAt(ev.clientX)
        if (d === days) return
        days = d
        setPreview({ rowId, mode, days })
      }
      const onUp = (ev: PointerEvent) => {
        const d = daysAt(ev.clientX)
        end()
        if (d !== 0) commitRef.current(rowId, mode, d)
      }
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') end()
      }
      function end() {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', end)
        window.removeEventListener('keydown', onKey)
        endRef.current = null
        setPreview(null)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', end)
      window.addEventListener('keydown', onKey)
      endRef.current = end
      setPreview({ rowId, mode, days: 0 })
    },
    [dayWidth],
  )

  return { preview, start }
}
