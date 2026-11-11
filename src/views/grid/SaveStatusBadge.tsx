import { useSheetStore } from '../../store/SheetStoreContext'
import type { SaveStatus } from '../../store/sheetStore'

const LABELS: Record<Exclude<SaveStatus, 'failed'>, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  unsaved: 'Unsaved changes — retrying…',
}

/** Save status of the sheet store, plus its notices (each dismissable). */
export function SaveStatusBadge() {
  const status = useSheetStore((s) => s.saveStatus)
  const notices = useSheetStore((s) => s.notices)
  const dismiss = useSheetStore((s) => s.dismissNotice)
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
      {/* Always mounted so screen readers announce notices as they are added. */}
      <div role="status" className="sheet-notices">
        {notices.length > 0 && (
          <ul>
            {notices.map((n, i) => (
              <li key={`${i}:${n}`}>
                <span>{n}</span>
                <button type="button" className="notice-dismiss" aria-label={`Dismiss: ${n}`} onClick={() => dismiss(i)}>
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
