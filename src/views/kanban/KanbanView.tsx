import { useId, useMemo, useRef, useState, type DragEvent } from 'react'
import { fullOrder } from '../../model/hierarchy'
import { rowNumbers } from '../../store/predecessors'
import { useSheetStore, useSheetStoreApi } from '../../store/SheetStoreContext'
import type { CardData } from './Card'
import { Lane } from './Lane'
import './kanban.css'

const NO_STATUS = 'No status'
const MSG_NO_PICKLIST = 'Add a dropdown (picklist) column to use the Kanban board'

export interface KanbanViewProps {
  /** The PICKLIST column to group by. Defaults to the status column, else the first picklist. */
  groupByColumnId?: string
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === ''

/**
 * Kanban board: one lane per option of a picklist column plus a "No status" lane. Cards are the
 * sheet's leaf rows. Moving a card (drag and drop, or the card's select) writes the picklist cell.
 */
export function KanbanView({ groupByColumnId }: KanbanViewProps) {
  const api = useSheetStoreApi()
  const data = useSheetStore((s) => s.data)
  const scheduled = useSheetStore((s) => s.scheduled)
  const [chosenId, setChosenId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overLane, setOverLane] = useState<number | null>(null)
  const dragId = useRef<string | null>(null)
  const groupSelectId = useId()

  const picklists = useMemo(() => data?.columns.filter((c) => c.type === 'PICKLIST') ?? [], [data?.columns])
  const groupCol =
    picklists.find((c) => c.id === chosenId) ??
    picklists.find((c) => c.id === groupByColumnId) ??
    picklists.find((c) => c.role === 'status') ??
    picklists[0]

  const percentCol = data?.columns.find((c) => c.role === 'percentComplete')?.id
  const laneNames = useMemo(() => [...(groupCol?.options ?? []), NO_STATUS], [groupCol])

  const lanes = useMemo<CardData[][]>(() => {
    const result: CardData[][] = laneNames.map(() => [])
    if (!data || !groupCol) return result
    const text = data.columns.filter((c) => c.type === 'TEXT_NUMBER')
    const nameCol = (text.find((c) => !c.role) ?? text[0])?.id
    const byId = new Map(data.rows.map((r) => [r.id, r]))
    const parents = new Set(data.rows.flatMap((r) => (r.parentId && byId.has(r.parentId) ? [r.parentId] : [])))
    const numbers = rowNumbers(data)
    const options = groupCol.options ?? []
    for (const id of fullOrder(data.rows)) {
      if (parents.has(id)) continue
      const row = byId.get(id)!
      const raw = nameCol ? row.cells[nameCol] : undefined
      const sched = scheduled.byRow[id]
      const value = row.cells[groupCol.id]
      const lane = typeof value === 'string' && options.includes(value) ? options.indexOf(value) : options.length
      let percent: string | undefined
      if (percentCol) {
        const p = sched ? sched.percentComplete : row.cells[percentCol]
        if (!isEmpty(p)) percent = `${p}%`
      }
      result[lane].push({
        rowId: id,
        name: isEmpty(raw) ? `Row ${numbers.get(id)}` : String(raw),
        dates: sched ? `${sched.start} – ${sched.end}` : undefined,
        percent,
        rawValue: lane === options.length && !isEmpty(value) ? String(value) : undefined,
      })
    }
    return result
  }, [data, groupCol, laneNames, scheduled.byRow, percentCol])

  if (!data) return null
  if (!groupCol) {
    return (
      <p role="status" className="kanban-empty">
        {MSG_NO_PICKLIST}
      </p>
    )
  }

  /** Move a card to a lane: the one place both drag and drop and the select go through. */
  function moveCard(rowId: string, laneIndex: number) {
    const col = groupCol!
    const currentLane = lanes.findIndex((l) => l.some((c) => c.rowId === rowId))
    if (currentLane === laneIndex) return
    const options = col.options ?? []
    const result = api.getState().setCell(rowId, col.id, laneIndex < options.length ? options[laneIndex] : '')
    setError(result.ok ? '' : result.error)
  }

  function clearDrag() {
    dragId.current = null
    setDraggingId(null)
    setOverLane(null)
  }

  function onDragStart(rowId: string, e: DragEvent) {
    dragId.current = rowId
    setDraggingId(rowId)
    setError('')
    e.dataTransfer?.setData('text/plain', rowId)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }

  function onDrop(laneIndex: number, e: DragEvent) {
    const rowId = dragId.current ?? e.dataTransfer?.getData('text/plain') ?? ''
    clearDrag()
    if (rowId) moveCard(rowId, laneIndex)
  }

  return (
    <div className="kanban">
      <div className="kanban-toolbar">
        <label htmlFor={groupSelectId}>Group by</label>
        <select
          id={groupSelectId}
          value={groupCol.id}
          onChange={(e) => {
            setChosenId(e.target.value)
            setError('')
          }}
        >
          {picklists.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <div role="status" className="kanban-status">
          {error}
        </div>
      </div>
      <div className="kanban-lanes">
        {laneNames.map((name, i) => (
          <Lane
            key={`${groupCol.id}:${i}`}
            index={i}
            name={name}
            cards={lanes[i]}
            laneNames={laneNames}
            draggingId={draggingId}
            dropTarget={overLane === i}
            onDragStart={onDragStart}
            onDragEnd={clearDrag}
            onDragOverLane={(idx) => overLane !== idx && setOverLane(idx)}
            onDragLeaveLane={(idx) => setOverLane((cur) => (cur === idx ? null : cur))}
            onDropOnLane={onDrop}
            onMove={moveCard}
          />
        ))}
      </div>
    </div>
  )
}
