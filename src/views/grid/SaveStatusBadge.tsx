import { useSheetStore, useSheetStoreApi } from '../../store/SheetStoreContext'
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
  const failedCount = useSheetStore((s) => s.failedCount)
  const api = useSheetStoreApi()
  const retry = () => api.getState().retryFailed()
  return (
    <div className="save-status">
      {status === 'failed' ? (
        <div className="save-failed">
          <div role="alert" className="save-failed-banner">
            {failedCount > 0
              ? `${failedCount} change${failedCount === 1 ? '' : 's'} could not be saved`
              : 'Some changes could not be saved'}
          </div>
          <button type="button" onClick={retry}>
            Retry
          </button>
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
