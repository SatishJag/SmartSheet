import { useId, type DragEvent } from 'react'

export interface CardData {
  rowId: string
  name: string
  /** `start – end`, when the row is scheduled. */
  dates?: string
  /** Percent complete, when the sheet has such a column. */
  percent?: string
  /** The raw status value when it is not one of the lanes. */
  rawValue?: string
}

export interface CardProps {
  card: CardData
  /** Index of the lane the card is in. */
  laneIndex: number
  laneNames: readonly string[]
  dragging: boolean
  onDragStart(rowId: string, e: DragEvent): void
  onDragEnd(): void
  onMove(rowId: string, laneIndex: number): void
}

/** One task. Draggable; the select is the keyboard / screen reader way to move it. */
export function Card({ card, laneIndex, laneNames, dragging, onDragStart, onDragEnd, onMove }: CardProps) {
  const selectId = useId()
  return (
    <li
      className={dragging ? 'kanban-card is-dragging' : 'kanban-card'}
      draggable
      onDragStart={(e) => onDragStart(card.rowId, e)}
      onDragEnd={onDragEnd}
    >
      <div className="kanban-card-name">{card.name}</div>
      {card.rawValue !== undefined && (
        <span className="kanban-card-badge" data-testid="raw-value">
          {card.rawValue}
        </span>
      )}
      {(card.dates || card.percent) && (
        <div className="kanban-card-meta">
          {card.dates && <span>{card.dates}</span>}
          {card.percent && <span>{card.percent}</span>}
        </div>
      )}
      <label className="kanban-card-move" htmlFor={selectId}>
        <span className="kanban-visually-hidden">Move {card.name} to</span>
        <select id={selectId} value={laneIndex} onChange={(e) => onMove(card.rowId, Number(e.target.value))}>
          {laneNames.map((n, i) => (
            <option key={i} value={i}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </li>
  )
}
