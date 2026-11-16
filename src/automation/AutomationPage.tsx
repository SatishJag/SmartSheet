import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Column } from '../model/validate'
import { useShell } from '../shell/ShellContext'
import { ConfirmDialog } from '../views/ConfirmDialog'
import { automationApi, type AutomationApi, type DbRun, type RequestRow, type RuleDraft } from './db'
import { describeRule } from './describe'
import { fetchStatus, type AutomationStatus } from './serverApi'
import type { AutomationRule } from './types'
import { defaultAction, defaultTrigger, doneOption, statusColumn } from './ui/editors'
import { RuleBuilder } from './ui/RuleBuilder'
import './automation.css'

const LAST_SHEET_KEY = 'automation:sheet'

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '')

/** Automation: rules per sheet, a builder with a test run, the activity log and the sent requests. */
export function AutomationPage() {
  const { client } = useShell()
  const api = useMemo(() => automationApi(client), [client])
  const [sheets, setSheets] = useState<{ id: string; name: string }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sheetId, setSheetId] = useState('')
  // undefined: not asked yet; null: the server cannot be reached
  const [status, setStatus] = useState<AutomationStatus | null | undefined>(undefined)
  // The rule builder shows the server note itself, and only when the rule needs the server.
  const [building, setBuilding] = useState(false)

  useEffect(() => {
    let live = true
    api.listSheets().then(
      (list) => {
        if (!live) return
        setSheets(list)
        let last = ''
        try {
          last = localStorage.getItem(LAST_SHEET_KEY) ?? ''
        } catch {
          /* storage unavailable */
        }
        setSheetId(list.some((s) => s.id === last) ? last : (list[0]?.id ?? ''))
      },
      (e: unknown) => live && setError(errorText(e, 'Could not load your sheets')),
    )
    void fetchStatus(client).then((s) => live && setStatus(s))
    return () => {
      live = false
    }
  }, [api, client])

  const serverNote =
    status === undefined
      ? null
      : status === null
        ? 'The planning server could not be reached. Rules that react to your own edits still run here; date and schedule rules, e-mail, update requests and approvals need the server.'
        : !status.enabled
          ? 'The server has no service key configured (see .env.example), so date and schedule rules, e-mail, update requests and approvals are off. Rules that react to your own edits and in-app notifications still work.'
          : status.mail === 'simulator'
            ? 'E-mail is simulated on this server: messages appear in your notification centre instead of being sent.'
            : null

  return (
    <div className="au-page">
      <header className="au-page-head">
        <div>
          <h1>Automation</h1>
          <p className="au-sub">Rules that notify people, ask for updates and approvals, and tidy rows when things change.</p>
        </div>
        {sheets && sheets.length > 0 && (
          <div className="au-sheet-pick">
            <label className="label" htmlFor="au-sheet">
              Sheet
            </label>
            <select
              id="au-sheet"
              className="input"
              value={sheetId}
              onChange={(e) => {
                setSheetId(e.currentTarget.value)
                try {
                  localStorage.setItem(LAST_SHEET_KEY, e.currentTarget.value)
                } catch {
                  /* storage unavailable */
                }
              }}
            >
              {sheets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </header>

      {serverNote && !building && (
        <p className="au-note" role="note">
          {serverNote}
        </p>
      )}

      {error ? (
        <p role="alert">{error}</p>
      ) : !sheets ? (
        <p className="au-hint">Loading…</p>
      ) : sheets.length === 0 ? (
        <div className="card au-empty">
          <h2>No sheets yet</h2>
          <p>Rules belong to a sheet. Create a sheet first, then come back.</p>
        </div>
      ) : (
        <SheetAutomation key={sheetId} api={api} sheetId={sheetId} sheets={sheets} serverNote={serverNote} onBuilding={setBuilding} />
      )}
    </div>
  )
}

type Tab = 'rules' | 'activity' | 'requests'

function SheetAutomation({ api, sheetId, sheets, serverNote, onBuilding }: { api: AutomationApi; sheetId: string; sheets: { id: string; name: string }[]; serverNote: string | null; onBuilding(b: boolean): void }) {
  const sheet = sheets.find((s) => s.id === sheetId)!
  const [columns, setColumns] = useState<Column[] | null>(null)
  const [rules, setRules] = useState<AutomationRule[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('rules')
  const [editing, setEditing] = useState<AutomationRule | 'new' | null>(null)
  const [deleting, setDeleting] = useState<AutomationRule | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const otherSheets = useMemo(() => sheets.filter((s) => s.id !== sheetId), [sheets, sheetId])
  useEffect(() => {
    onBuilding(editing !== null)
    return () => onBuilding(false)
  }, [editing, onBuilding])

  const reload = useCallback(async () => {
    try {
      const [cols, list] = await Promise.all([api.listColumns(sheetId), api.listRules(sheetId)])
      setColumns(cols)
      setRules(list)
    } catch (e) {
      setLoadError(errorText(e, 'Could not load the rules'))
    }
  }, [api, sheetId])
  useEffect(() => {
    void reload()
  }, [reload])

  const loadRows = useCallback(() => api.listRows(sheetId), [api, sheetId])

  async function save(draft: RuleDraft): Promise<string | null> {
    try {
      if (editing && editing !== 'new') await api.updateRule(editing.id, draft)
      else await api.createRule(draft)
      setEditing(null)
      await reload()
      return null
    } catch (e) {
      return errorText(e, 'Could not save the rule')
    }
  }

  async function toggle(rule: AutomationRule, enabled: boolean) {
    setRules((rs) => rs && rs.map((r) => (r.id === rule.id ? { ...r, enabled } : r)))
    try {
      await api.setEnabled(rule.id, enabled)
      setActionError(null)
    } catch (e) {
      setActionError(errorText(e, 'Could not change the rule'))
      await reload()
    }
  }

  async function remove(rule: AutomationRule) {
    setDeleting(null)
    try {
      await api.deleteRule(rule.id)
      await reload()
    } catch (e) {
      setActionError(errorText(e, 'Could not delete the rule'))
    }
  }

  if (loadError) {
    return (
      <p role="alert">
        {loadError}. If this is a new installation, the automation tables (migration 0009) may not be applied yet.
      </p>
    )
  }
  if (!columns || !rules) return <p className="au-hint">Loading…</p>

  if (editing) {
    return (
      <RuleBuilder
        sheetId={sheetId}
        sheetName={sheet.name}
        columns={columns}
        otherSheets={otherSheets}
        initial={editing === 'new' ? undefined : editing}
        loadRows={loadRows}
        onSave={save}
        onCancel={() => setEditing(null)}
        serverNote={serverNote}
      />
    )
  }

  return (
    <>
      <div className="au-tabbar">
        <div role="tablist" aria-label="Automation" className="segmented">
          {(['rules', 'activity', 'requests'] as Tab[]).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)}>
              {t === 'rules' ? 'Rules' : t === 'activity' ? 'Activity' : 'Sent requests'}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {tab === 'rules' && (
          <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
            New rule
          </button>
        )}
      </div>

      {actionError && <p role="alert">{actionError}</p>}

      {tab === 'rules' && (
        <>
          {rules.length === 0 ? (
            <Empty columns={columns} onStart={(draft) => void api.createRule(draft).then(reload, (e: unknown) => setActionError(errorText(e, 'Could not create the rule')))} sheetId={sheetId} onNew={() => setEditing('new')} otherSheets={otherSheets} />
          ) : (
            <ul className="au-rules" aria-label="Rules">
              {rules.map((r) => (
                <li key={r.id} className={r.enabled ? 'card au-rule' : 'card au-rule is-off'}>
                  <div className="au-rule-main">
                    <h3>{r.name}</h3>
                    <p className="au-rule-summary">{describeRule(r, columns)}</p>
                    <p className="au-rule-meta">{r.lastRunAt ? `Last ran ${when(r.lastRunAt)}` : 'Has not run yet'}</p>
                  </div>
                  <div className="au-rule-actions">
                    <label className="switch">
                      <input type="checkbox" checked={r.enabled} aria-label={`Rule ${r.name} is on`} onChange={(e) => void toggle(r, e.currentTarget.checked)} />
                      <span className="switch-track" aria-hidden="true" />
                      <span className="au-switch-text">{r.enabled ? 'On' : 'Off'}</span>
                    </label>
                    <button type="button" className="btn-sm" onClick={() => setEditing(r)} aria-label={`Edit rule ${r.name}`}>
                      Edit
                    </button>
                    <button type="button" className="btn-sm" onClick={() => setDeleting(r)} aria-label={`Delete rule ${r.name}`}>
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {tab === 'activity' && <Activity api={api} sheetId={sheetId} />}
      {tab === 'requests' && <Requests api={api} sheetId={sheetId} />}

      {deleting && (
        <ConfirmDialog
          title="Delete this rule?"
          message={`"${deleting.name}" will stop running. Its history stays in the activity log.`}
          confirmLabel="Delete rule"
          onConfirm={() => void remove(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  )
}

/** First-run help: two starters built from the sheet's own columns. */
function Empty({ columns, sheetId, onStart, onNew, otherSheets }: { columns: readonly Column[]; sheetId: string; onStart(d: RuleDraft): void; onNew(): void; otherSheets: readonly { id: string }[] }) {
  const status = statusColumn(columns)
  const date = columns.find((c) => c.type === 'DATE' && c.role !== 'start' && c.role !== 'end') ?? columns.find((c) => c.type === 'DATE')
  const done = doneOption(status)
  return (
    <div className="card au-empty">
      <h2>No rules on this sheet yet</h2>
      <p>A rule has a trigger, optional conditions and one action. Start from an example or build your own.</p>
      <div className="au-actions">
        {status && done && (
          <button
            type="button"
            onClick={() =>
              onStart({
                sheetId,
                name: `Tell me when ${status.title} becomes ${done}`,
                enabled: true,
                trigger: { type: 'cell_becomes', columnId: status.id, value: done },
                conditions: null,
                action: defaultAction('notify', columns, otherSheets as { id: string }[]),
              })
            }
          >
            Notify me when {status.title} becomes {done}
          </button>
        )}
        {date && (
          <button
            type="button"
            onClick={() =>
              onStart({
                sheetId,
                name: `Remind me 3 days before ${date.title}`,
                enabled: true,
                trigger: { ...defaultTrigger('date', columns), columnId: date.id } as RuleDraft['trigger'],
                conditions: null,
                action: defaultAction('notify', columns, otherSheets as { id: string }[]),
              })
            }
          >
            Remind me 3 days before {date.title}
          </button>
        )}
        <button type="button" className="btn-primary" onClick={onNew}>
          Build a rule
        </button>
      </div>
    </div>
  )
}

const OUTCOME: Record<DbRun['outcome'], string> = { done: 'Done', skipped: 'Skipped', error: 'Failed', dry_run: 'Test' }

function runDetail(r: DbRun): string {
  const d = r.detail as { reason?: string; steps?: { action: string; error?: string }[]; errors?: { action: string; error: string }[]; planned?: string[]; notes?: string[] }
  if (r.outcome === 'skipped') {
    return d.reason === 'loop' ? 'Not run again for its own change' : d.reason === 'depth' ? 'Stopped: too many rules in a chain' : d.reason === 'throttled' ? 'Held back: too many runs a minute' : d.reason === 'locked' ? 'The row is locked' : (d.reason ?? '')
  }
  const failed = d.errors ?? d.steps?.filter((s) => s.error)
  if (failed && failed.length > 0) return failed.map((f) => `${f.action}: ${'error' in f ? f.error : ''}`).join('; ')
  return (d.steps?.map((s) => s.action) ?? d.planned ?? d.notes ?? []).join('; ')
}

function Activity({ api, sheetId }: { api: AutomationApi; sheetId: string }) {
  const [runs, setRuns] = useState<DbRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.listRuns(sheetId, 50).then(setRuns, (e: unknown) => setError(errorText(e, 'Could not load the activity')))
  }, [api, sheetId])
  if (error) return <p role="alert">{error}</p>
  if (!runs) return <p className="au-hint">Loading…</p>
  if (runs.length === 0) return <p className="au-hint">Nothing has run yet. Every run of a rule, successful or not, is listed here.</p>
  return (
    <ul className="au-runs" aria-label="Activity">
      {runs.map((r) => (
        <li key={r.id} className="card au-run">
          <span className={`au-badge is-${r.outcome}`}>{OUTCOME[r.outcome]}</span>
          <div className="au-run-main">
            <strong>{r.rule_name}</strong>
            {typeof (r.detail as { row?: string }).row === 'string' && <span className="au-run-row"> · {(r.detail as { row: string }).row}</span>}
            <p className="au-run-detail">{runDetail(r)}</p>
          </div>
          <span className="au-run-when">
            {when(r.created_at)} · {r.source === 'server' ? 'server' : 'browser'}
          </span>
        </li>
      ))}
    </ul>
  )
}

const REQUEST_STATUS: Record<string, string> = { pending: 'Waiting', responded: 'Answered', approved: 'Approved', declined: 'Declined', expired: 'Expired', revoked: 'Withdrawn' }

function Requests({ api, sheetId }: { api: AutomationApi; sheetId: string }) {
  const [items, setItems] = useState<RequestRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => api.listRequests(sheetId).then(setItems, (e: unknown) => setError(errorText(e, 'Could not load the requests'))), [api, sheetId])
  useEffect(() => {
    void load()
  }, [load])
  if (error) return <p role="alert">{error}</p>
  if (!items) return <p className="au-hint">Loading…</p>
  if (items.length === 0) return <p className="au-hint">No update requests or approvals have been sent from this sheet.</p>
  return (
    <ul className="au-runs" aria-label="Sent requests">
      {items.map((r) => (
        <li key={`${r.kind}-${r.id}`} className="card au-run">
          <span className={`au-badge is-${r.status}`}>{REQUEST_STATUS[r.status] ?? r.status}</span>
          <div className="au-run-main">
            <strong>{r.kind === 'update' ? 'Update request' : 'Approval'}</strong> to {r.recipient}
            <p className="au-run-detail">
              Sent {when(r.createdAt)}
              {r.respondedAt ? ` · answered ${when(r.respondedAt)}` : r.status === 'pending' ? ` · expires ${when(r.expiresAt)}` : ''}
              {r.comment ? ` · “${r.comment}”` : ''}
            </p>
          </div>
          {r.status === 'pending' && (
            <button
              type="button"
              className="btn-sm"
              onClick={() => void api.revokeRequest(r.kind, r.id).then(load, (e: unknown) => setError(errorText(e, 'Could not withdraw the request')))}
            >
              Withdraw
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}
