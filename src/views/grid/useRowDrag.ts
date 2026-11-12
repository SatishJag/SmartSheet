import { useRef, useState, type DragEvent } from 'react'
import { isDescendant } from './viewModel'

interface RowDragOptions {
  /** Dragging is off while a sort or filter is active (display order is not tree order). */
  enabled: boolean
  parentOf(id: string): string | null | undefined
  /** Move `id` to just after `targetId`, as its sibling. */
  onMove(id: string, targetId: string): void
}

/**
 * Native HTML5 drag-to-reorder: the row-number cell is the handle, any row is a drop target.
 * Dropping a row onto itself or one of its descendants does nothing.
 */
export function useRowDrag({ enabled, parentOf, onMove }: RowDragOptions) {
  const dragId = useRef<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const canDrop = (targetId: string) =>
    enabled && dragId.current !== null && targetId !== dragId.current && !isDescendant(parentOf, dragId.current, targetId)

  function reset() {
    dragId.current = null
    setOverId(null)
  }

  function handleProps(rowId: string) {
    if (!enabled) return { draggable: false }
    return {
      draggable: true,
      onDragStart(e: DragEvent) {
        dragId.current = rowId
        e.dataTransfer?.setData('text/plain', rowId)
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
      },
      onDragEnd: reset,
    }
  }

  function rowProps(rowId: string) {
    return {
      onDragOver(e: DragEvent) {
        if (!canDrop(rowId)) return
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
        if (overId !== rowId) setOverId(rowId)
      },
      onDragLeave() {
        if (overId === rowId) setOverId(null)
      },
      onDrop(e: DragEvent) {
        e.preventDefault()
        const id = dragId.current
        if (id !== null && canDrop(rowId)) onMove(id, rowId)
        reset()
      },
    }
  }

  return { handleProps, rowProps, overId }
}
