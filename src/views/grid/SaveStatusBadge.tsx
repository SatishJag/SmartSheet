import { useSheetStore, useSheetStoreApi } from '../../store/SheetStoreContext'
import type { SaveStatus } from '../../store/sheetStore'
import { Icon } from '../../ui/Icon'

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
            <Icon name="alert" size={15} />
            {failedCount > 0
              ? `${failedCount} change${failedCount === 1 ? '' : 's'} could not be saved`
              : 'Some changes could not be saved'}
          </div>
          <button type="button" className="btn-sm" onClick={retry}>
            Retry
          </button>
        </div>
      ) : (
        <span className={`save-badge is-${status}`} aria-live="polite">
          {status === 'saving' ? <span className="save-spinner" aria-hidden="true" /> : <Icon name={status === 'saved' ? 'check' : 'cloud'} size={14} strokeWidth={2.4} />}
          <span>{LABELS[status]}</span>
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
                  <Icon name="plus" size={14} className="x-icon" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
