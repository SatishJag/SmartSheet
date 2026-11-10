import type { ReactNode } from 'react'

export const INDENT_PX = 16

interface HierarchyCellProps {
  depth: number
  hasChildren: boolean
  expanded: boolean
  /** The row's name, for the toggle's accessible label. */
  name: string
  onToggle(): void
  children: ReactNode
}

/**
 * Content of the primary column: indentation per depth plus a collapse/expand toggle on
 * parent rows. The toggle is out of the tab order (the grid keeps one tab stop) and does
 * not select the cell or open an editor.
 */
export function HierarchyCell({ depth, hasChildren, expanded, name, onToggle, children }: HierarchyCellProps) {
  return (
    <span className="hierarchy-cell" style={{ paddingLeft: depth * INDENT_PX }}>
      {hasChildren ? (
        <button
          type="button"
          className={`row-toggle${expanded ? ' is-expanded' : ''}`}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
          tabIndex={-1}
          // Keep focus where it is: focusing the toggle would make its cell the active cell.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <span className="chevron" aria-hidden="true" />
        </button>
      ) : (
        <span className="row-toggle-spacer" aria-hidden="true" />
      )}
      {children}
    </span>
  )
}
