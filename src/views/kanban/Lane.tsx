import { useState, type DragEvent } from 'react'
import { Card, type CardData } from './Card'

/** Cards rendered per lane before "Show more". */
export const LANE_PAGE_SIZE = 100

export interface LaneProps {
  index: number
  name: string
  cards: readonly CardData[]
  laneNames: readonly string[]
  draggingId: string | null
  dropTarget: boolean
  onDragStart(rowId: string, e: DragEvent): void
  onDragEnd(): void
  onDragOverLane(index: number): void
  onDragLeaveLane(index: number): void
  onDropOnLane(index: number, e: DragEvent): void
  onMove(rowId: string, laneIndex: number): void
}

export function Lane({
  index,
  name,
  cards,
  laneNames,
  draggingId,
  dropTarget,
  onDragStart,
  onDragEnd,
  onDragOverLane,
  onDragLeaveLane,
  onDropOnLane,
  onMove,
}: LaneProps) {
  const [limit, setLimit] = useState(LANE_PAGE_SIZE)
  const title = `${name} (${cards.length})`
  const hidden = cards.length - limit

  return (
    <section
      role="region"
      aria-label={title}
      className={dropTarget ? 'kanban-lane is-drop-target' : 'kanban-lane'}
      onDragOver={(e) => {
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
        onDragOverLane(index)
      }}
      onDragLeave={(e) => {
        // Moving between the lane's own children also fires dragleave; ignore that.
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
        onDragLeaveLane(index)
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDropOnLane(index, e)
      }}
    >
      <h3 className="kanban-lane-title">{title}</h3>
      {cards.length === 0 ? (
        <p className="kanban-lane-empty">No cards</p>
      ) : (
        <ul className="kanban-cards">
          {cards.slice(0, limit).map((c) => (
            <Card
              key={c.rowId}
              card={c}
              laneIndex={index}
              laneNames={laneNames}
              dragging={draggingId === c.rowId}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onMove={onMove}
            />
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <button type="button" className="kanban-show-more" onClick={() => setLimit((l) => l + LANE_PAGE_SIZE)}>
          Show {Math.min(LANE_PAGE_SIZE, hidden)} more
        </button>
      )}
    </section>
  )
}
