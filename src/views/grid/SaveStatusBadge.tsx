import { useSheetStore } from '../../store/SheetStoreContext'
import type { SaveStatus } from '../../store/sheetStore'

const LABELS: Record<Exclude<SaveStatus, 'failed'>, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  unsaved: 'Unsaved changes — retrying…',
}

/** Save status of the sheet store, plus its notices (read-only for now). */
export function SaveStatusBadge() {
  const status = useSheetStore((s) => s.saveStatus)
  const notices = useSheetStore((s) => s.notices)
  return (
    <div className="save-status">
      {status === 'failed' ? (
        <div role="alert" className="save-failed-banner">
          Some changes could not be saved
        </div>
      ) : (
        <span className={`save-badge is-${status}`} aria-live="polite">
          {LABELS[status]}
        </span>
      )}
      {notices.length > 0 && (
        <div role="status" className="sheet-notices">
          <ul>
            {notices.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
