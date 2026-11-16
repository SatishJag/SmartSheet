import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useShell } from '../shell/ShellContext'
import { Icon } from '../ui/Icon'
import { onNotificationsChanged } from './bus'
import { automationApi, type DbNotification } from './db'
import './automation.css'

const POLL_MS = 30_000
const SHOWN = 30

function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * The notification centre: a bell in the app header with the number of unread notifications. Rules put
 * their in-app messages here (see runtime.ts / the server's scheduler). It refreshes when a rule fires
 * in this browser, when the window regains focus and every 30 seconds. If the tables are missing it
 * simply stays empty: the app never depends on it.
 */
export function NotificationBell() {
  const { client, openSheet } = useShell()
  const api = useMemo(() => automationApi(client), [client])
  const [items, setItems] = useState<DbNotification[]>([])
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const root = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      setItems(await api.listNotifications(SHOWN))
    } catch {
      /* not available (migration not applied, offline): keep what we have */
    }
  }, [api])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    const off = onNotificationsChanged(() => void refresh())
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      off()
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const unread = items.filter((i) => !i.read_at)
  const count = unread.length

  async function markRead(ids: string[]) {
    const stamp = new Date().toISOString()
    setItems((list) => list.map((i) => (ids.includes(i.id) ? { ...i, read_at: i.read_at ?? stamp } : i)))
    try {
      await api.markRead(ids)
    } catch {
      void refresh()
    }
  }

  function openItem(n: DbNotification) {
    if (!n.read_at) void markRead([n.id])
    setOpen(false)
    if (n.sheet_id) openSheet(n.sheet_id)
  }

  return (
    <div className="nb" ref={root}>
      <button
        type="button"
        className="nb-button"
        aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((o) => !o)
          if (!open) void refresh()
        }}
      >
        <Icon name="bell" size={18} />
        {count > 0 && (
          <span className="nb-badge" aria-hidden="true">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>
      {open && (
        <div id={panelId} className="nb-panel rise" role="region" aria-label="Notifications">
          <div className="nb-head">
            <strong>Notifications</strong>
            <span className="spacer" />
            <button type="button" className="btn-sm" disabled={count === 0} onClick={() => void markRead(unread.map((i) => i.id))}>
              Mark all read
            </button>
          </div>
          {items.length === 0 ? (
            <p className="nb-empty">Nothing yet. Notifications from your automation rules appear here.</p>
          ) : (
            <ul className="nb-list">
              {items.map((n) => (
                <li key={n.id} className={n.read_at ? 'nb-item' : 'nb-item is-unread'}>
                  <button type="button" className="nb-item-btn" onClick={() => openItem(n)}>
                    <span className="nb-title">
                      {!n.read_at && <span className="visually-hidden">Unread: </span>}
                      {n.title}
                    </span>
                    {n.body && <span className="nb-body">{n.body}</span>}
                    <span className="nb-time">
                      {ago(n.created_at)}
                      {n.sheet_id ? ' · open sheet' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
