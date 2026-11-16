import { useEffect, useMemo, useState } from 'react'
import type { Column } from '../../model/validate'
import type { RuleDraft } from '../db'
import { describePlanned, describeRule } from '../describe'
import { dryRun, rowLabel, type DryRunResult } from '../engine'
import type { AutomationRule, RowSnapshot } from '../types'
import { validateRule } from '../validateRule'
import { ActionEditor, ConditionsEditor, defaultAction, defaultTrigger, TriggerEditor } from './editors'

export interface RuleBuilderProps {
  sheetId: string
  sheetName: string
  columns: readonly Column[]
  otherSheets: readonly { id: string; name: string }[]
  initial?: AutomationRule
  /** Loads some rows of the sheet for the test run. */
  loadRows(): Promise<RowSnapshot[]>
  onSave(draft: RuleDraft): Promise<string | null>
  onCancel(): void
  /** What the server cannot do right now, to warn before the rule is saved. */
  serverNote?: string | null
}

export function RuleBuilder({ sheetId, sheetName, columns, otherSheets, initial, loadRows, onSave, onCancel, serverNote }: RuleBuilderProps) {
  const [draft, setDraft] = useState<RuleDraft>(() =>
    initial
      ? { sheetId, name: initial.name, enabled: initial.enabled, trigger: initial.trigger, conditions: initial.conditions, action: initial.action }
      : { sheetId, name: '', enabled: true, trigger: defaultTrigger('cell_becomes', columns), conditions: null, action: defaultAction('notify', columns, otherSheets) },
  )
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const summary = useMemo(() => describeRule(draft, columns), [draft, columns])
  const needsServer = draft.trigger.type === 'date' || draft.trigger.type === 'schedule' || draft.action.type === 'update_request' || draft.action.type === 'approval' || (draft.action.type === 'notify' && draft.action.recipients.some((r) => r.kind !== 'owner'))

  async function save() {
    const found = validateRule(draft, columns, otherSheets.map((s) => s.id))
    setErrors(found)
    if (found.length > 0) return
    setSaving(true)
    const error = await onSave({ ...draft, name: draft.name.trim() })
    setSaving(false)
    if (error) setErrors([error])
  }

  return (
    <form
      className="au-builder"
      aria-label={initial ? `Edit rule ${initial.name}` : 'New rule'}
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="au-builder-head">
        <h2>{initial ? 'Edit rule' : 'New rule'}</h2>
        <span className="au-sheet-chip">{sheetName}</span>
      </div>

      <div className="au-field">
        <label className="label" htmlFor="rule-name">
          Rule name
        </label>
        <input id="rule-name" className="input" value={draft.name} maxLength={100} placeholder="e.g. Tell me when a task is done" onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })} />
      </div>

      <section className="card au-step" aria-labelledby="au-when">
        <h3 id="au-when">
          <span className="au-num">1</span> Trigger
        </h3>
        <TriggerEditor value={draft.trigger} columns={columns} onChange={(trigger) => setDraft({ ...draft, trigger })} />
      </section>

      <section className="card au-step" aria-labelledby="au-if">
        <h3 id="au-if">
          <span className="au-num">2</span> Conditions <span className="au-optional">optional</span>
        </h3>
        <ConditionsEditor value={draft.conditions} columns={columns} onChange={(conditions) => setDraft({ ...draft, conditions })} />
      </section>

      <section className="card au-step" aria-labelledby="au-then">
        <h3 id="au-then">
          <span className="au-num">3</span> Action
        </h3>
        <ActionEditor value={draft.action} columns={columns} otherSheets={otherSheets} onChange={(action) => setDraft({ ...draft, action })} />
      </section>

      <p className="au-summary" aria-live="polite" data-testid="rule-summary">
        <strong>In words:</strong> {summary}
      </p>
      {needsServer && serverNote && (
        <p className="au-note" role="note">
          {serverNote}
        </p>
      )}

      <TestRun draft={draft} sheetId={sheetId} sheetName={sheetName} columns={columns} loadRows={loadRows} />

      {errors.length > 0 && (
        <div className="au-errors" role="alert">
          <strong>Fix this before saving:</strong>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="au-footer">
        <label className="switch">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.currentTarget.checked })} />
          <span className="switch-track" aria-hidden="true" />
          Turn the rule on
        </label>
        <span className="spacer" />
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save rule'}
        </button>
      </div>
    </form>
  )
}

/** Try the rule on a real row of the sheet without changing anything. */
function TestRun({ draft, sheetId, sheetName, columns, loadRows }: { draft: RuleDraft; sheetId: string; sheetName: string; columns: readonly Column[]; loadRows(): Promise<RowSnapshot[]> }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<RowSnapshot[] | null>(null)
  const [rowId, setRowId] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || rows) return
    loadRows().then(
      (r) => {
        setRows(r)
        setRowId(r[0]?.id ?? '')
      },
      (e: unknown) => setError(e instanceof Error ? e.message : 'Could not load rows'),
    )
  }, [open, rows, loadRows])

  const ctx = useMemo(() => ({ sheetId, sheetName, columns, now: Date.now(), tzOffsetMinutes: -new Date().getTimezoneOffset() }), [sheetId, sheetName, columns])
  const result = useMemo<DryRunResult | null>(() => {
    const row = rows?.find((r) => r.id === rowId)
    if (!row) return null
    const rule: AutomationRule = { id: 'test', sheetId, name: draft.name || 'This rule', enabled: true, trigger: draft.trigger, conditions: draft.conditions, action: draft.action, createdAt: new Date().toISOString() }
    return dryRun(rule, row, ctx)
  }, [rows, rowId, draft, sheetId, ctx])

  return (
    <section className="card au-step au-test" aria-labelledby="au-test">
      <h3 id="au-test">Test run</h3>
      {!open ? (
        <>
          <p className="au-hint">See what this rule would do for one of your rows. Nothing is changed or sent.</p>
          <button type="button" onClick={() => setOpen(true)}>
            Test on a row
          </button>
        </>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : !rows ? (
        <p className="au-hint">Loading rows…</p>
      ) : rows.length === 0 ? (
        <p className="au-hint">This sheet has no rows to test with.</p>
      ) : (
        <>
          <div className="au-field">
            <label className="label" htmlFor="test-row">
              Row to test
            </label>
            <select id="test-row" className="input" value={rowId} onChange={(e) => setRowId(e.currentTarget.value)}>
              {rows.map((r) => (
                <option key={r.id} value={r.id}>
                  {rowLabel(r.cells, ctx)}
                </option>
              ))}
            </select>
          </div>
          {result && (
            <div className="au-result" role="status" aria-live="polite" data-testid="test-result">
              <p className="au-hint">Assuming the trigger fires for this row:</p>
              {result.conditions.length > 0 && (
                <ul className="au-cond-results">
                  {result.conditions.map((c, i) => (
                    <li key={i} className={c.pass ? 'is-pass' : 'is-fail'}>
                      <span aria-hidden="true">{c.pass ? '✓' : '✗'}</span> {c.text}
                      <span className="visually-hidden">{c.pass ? ' (met)' : ' (not met)'}</span>
                    </li>
                  ))}
                </ul>
              )}
              {!result.conditionsPass || !result.run ? (
                <p>
                  <strong>The conditions are not met, so nothing would happen.</strong>
                </p>
              ) : result.run.actions.length === 0 ? (
                <p>
                  <strong>Nothing would happen:</strong> {result.run.notes?.join('; ') ?? 'no action applies'}.
                </p>
              ) : (
                <>
                  <p>
                    <strong>It would:</strong>
                  </p>
                  <ul>
                    {result.run.actions.map((a, i) => (
                      <li key={i}>{describePlanned(a, columns)}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
