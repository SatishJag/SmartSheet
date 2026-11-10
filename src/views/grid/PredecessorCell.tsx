import { useSheetStore } from '../../store/SheetStoreContext'
import { predecessorTooltip } from '../../store/predecessors'

/**
 * A predecessor cell's display: the text derived from the sheet's dependencies (not from
 * `cells`), with a tooltip naming each predecessor as "<row number>: <row name>".
 */
export function PredecessorCell({ rowId, text }: { rowId: string; text: string }) {
  const data = useSheetStore((s) => s.data)
  const title = text && data ? predecessorTooltip(data, rowId) : undefined
  return (
    <span className="cell-text" title={title || undefined}>
      {text}
    </span>
  )
}
