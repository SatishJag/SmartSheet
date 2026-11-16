/** The three parts of a rule in the builder: trigger, conditions, action. Each edits plain data. */
import { useState } from 'react'
import type { Column } from '../../model/validate'
import { opNeedsValue } from '../conditions'
import { isEmail } from '../values'
import { isGroup, type Action, type ActionType, type Condition, type ConditionGroup, type Frequency, type Recipient, type Trigger, type TriggerType } from '../types'
import { REQUESTABLE } from '../validateRule'
import { ColumnSelect, Field, opsFor, ValueInput } from './fields'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// ---------------------------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------------------------

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  row_added: 'A row is added',
  row_changed: 'A row is changed',
  cell_becomes: 'A cell becomes a value',
  date: 'A date arrives',
  schedule: 'On a schedule',
}

/** The sheet's status column (a dropdown with the status role), else its first dropdown. */
export function statusColumn(cols: readonly Column[]): Column | undefined {
  return cols.find((c) => c.type === 'PICKLIST' && c.role === 'status') ?? cols.find((c) => c.type === 'PICKLIST')
}

/** The option that means finished ("Done", "Complete"...), else the last option. */
export function doneOption(col: Column | undefined): string {
  const opts = col?.options ?? []
  return opts.find((o) => /^(done|complete|completed|closed)$/i.test(o)) ?? opts[opts.length - 1] ?? ''
}

export function defaultTrigger(type: TriggerType, cols: readonly Column[]): Trigger {
  switch (type) {
    case 'row_added':
      return { type }
    case 'row_changed':
      return { type, columnIds: [] }
    case 'cell_becomes': {
      const pick = statusColumn(cols) ?? cols[0]
      return { type, columnId: pick?.id ?? '', value: pick?.type === 'PICKLIST' ? doneOption(pick) : '' }
    }
    case 'date':
      return { type, columnId: cols.find((c) => c.type === 'DATE')?.id ?? '', when: 'before', days: 3 }
    case 'schedule':
      return { type, frequency: 'weekly', time: '09:00', weekday: 1 }
  }
}

export function TriggerEditor({ value, columns, onChange }: { value: Trigger; columns: readonly Column[]; onChange(t: Trigger): void }) {
  const col = (id: string) => columns.find((c) => c.id === id)
  return (
    <div className="au-grid">
      <Field label="When">
        {(id) => (
          <select id={id} className="input" value={value.type} onChange={(e) => onChange(defaultTrigger(e.currentTarget.value as TriggerType, columns))}>
            {(Object.keys(TRIGGER_LABELS) as TriggerType[]).map((t) => (
              <option key={t} value={t}>
                {TRIGGER_LABELS[t]}
              </option>
            ))}
          </select>
        )}
      </Field>

      {value.type === 'row_changed' && (
        <fieldset className="au-field au-wide">
          <legend className="label">Only when one of these columns changes (leave all unchecked for any column)</legend>
          <div className="au-checks">
            {columns.map((c) => (
              <label key={c.id} className="au-check">
                <input
                  type="checkbox"
                  checked={(value.columnIds ?? []).includes(c.id)}
                  onChange={(e) => {
                    const set = new Set(value.columnIds ?? [])
                    if (e.currentTarget.checked) set.add(c.id)
                    else set.delete(c.id)
                    onChange({ type: 'row_changed', columnIds: [...set] })
                  }}
                />
                {c.title}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {value.type === 'cell_becomes' && (
        <>
          <Field label="Column">
            {(id) => <ColumnSelect id={id} columns={columns} value={value.columnId} onChange={(columnId) => onChange({ type: 'cell_becomes', columnId, value: col(columnId)?.type === 'PICKLIST' ? (col(columnId)!.options?.[0] ?? '') : '' })} />}
          </Field>
          <Field label="Becomes">{(id) => <ValueInput id={id} column={col(value.columnId)} value={value.value} onChange={(v) => onChange({ ...value, value: v })} />}</Field>
        </>
      )}

      {value.type === 'date' && (
        <>
          <Field label="Date column">{(id) => <ColumnSelect id={id} columns={columns} filter={(c) => c.type === 'DATE'} value={value.columnId} onChange={(columnId) => onChange({ ...value, columnId })} placeholder="Choose a date column" />}</Field>
          <Field label="Timing">
            {(id) => (
              <select id={id} className="input" value={value.when} onChange={(e) => onChange({ ...value, when: e.currentTarget.value as 'before' | 'on' | 'after' })}>
                <option value="before">Days before the date</option>
                <option value="on">On the date</option>
                <option value="after">Days after the date</option>
              </select>
            )}
          </Field>
          {value.when !== 'on' && (
            <Field label="Number of days">
              {(id) => <input id={id} className="input" type="number" min={1} max={365} value={value.days} onChange={(e) => onChange({ ...value, days: Number(e.currentTarget.value) })} />}
            </Field>
          )}
        </>
      )}

      {value.type === 'schedule' && (
        <>
          <Field label="Repeats">
            {(id) => (
              <select id={id} className="input" value={value.frequency} onChange={(e) => onChange({ ...value, frequency: e.currentTarget.value as 'daily' | 'weekly' | 'monthly', weekday: value.weekday ?? 1, dayOfMonth: value.dayOfMonth ?? 1 })}>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
                <option value="monthly">Every month</option>
              </select>
            )}
          </Field>
          {value.frequency === 'weekly' && (
            <Field label="Day of the week">
              {(id) => (
                <select id={id} className="input" value={value.weekday ?? 1} onChange={(e) => onChange({ ...value, weekday: Number(e.currentTarget.value) })}>
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          {value.frequency === 'monthly' && (
            <Field label="Day of the month" hint="A short month uses its last day.">
              {(id) => <input id={id} className="input" type="number" min={1} max={31} value={value.dayOfMonth ?? 1} onChange={(e) => onChange({ ...value, dayOfMonth: Number(e.currentTarget.value) })} />}
            </Field>
          )}
          <Field label="Time (UTC)" hint="The server runs it at this time of day, UTC.">
            {(id) => <input id={id} className="input" type="time" value={value.time} onChange={(e) => onChange({ ...value, time: e.currentTarget.value })} />}
          </Field>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------------------------

export function newCondition(cols: readonly Column[]): Condition {
  const c = cols[0]
  return { columnId: c?.id ?? '', op: c?.type === 'DATE' ? 'is_past' : 'is_not_blank' }
}

function ConditionRow({ value, columns, onChange, onRemove }: { value: Condition; columns: readonly Column[]; onChange(c: Condition): void; onRemove(): void }) {
  const col = columns.find((c) => c.id === value.columnId)
  const ops = opsFor(col)
  return (
    <div className="au-cond" role="group" aria-label="Condition">
      <ColumnSelect label="Condition column" columns={columns} value={value.columnId} onChange={(columnId) => onChange({ columnId, op: opsFor(columns.find((c) => c.id === columnId)).some((o) => o.op === value.op) ? value.op : 'is_not_blank' })} />
      <select aria-label="Condition operator" className="input" value={value.op} onChange={(e) => onChange({ columnId: value.columnId, op: e.currentTarget.value as Condition['op'] })}>
        {ops.map((o) => (
          <option key={o.op} value={o.op}>
            {o.label}
          </option>
        ))}
      </select>
      {opNeedsValue(value.op) &&
        (value.op === 'in_next_days' ? (
          <input aria-label="Number of days" className="input" type="number" min={0} value={value.value == null ? '' : String(value.value)} onChange={(e) => onChange({ ...value, value: e.currentTarget.value })} />
        ) : (
          <ValueInput label="Condition value" column={col} value={value.value} onChange={(v) => onChange({ ...value, value: v })} />
        ))}
      <button type="button" className="btn-icon is-danger" aria-label="Remove condition" onClick={onRemove}>
        ×
      </button>
    </div>
  )
}

function GroupEditor({ group, columns, depth, onChange, onRemove }: { group: ConditionGroup; columns: readonly Column[]; depth: number; onChange(g: ConditionGroup): void; onRemove?: () => void }) {
  const set = (i: number, item: Condition | ConditionGroup) => onChange({ ...group, items: group.items.map((x, j) => (j === i ? item : x)) })
  const drop = (i: number) => onChange({ ...group, items: group.items.filter((_, j) => j !== i) })
  return (
    <div className={depth > 0 ? 'au-group au-group-nested' : 'au-group'} role="group" aria-label={depth > 0 ? 'Condition group' : 'Conditions'}>
      <div className="au-group-head">
        <span>Match</span>
        <select aria-label={depth > 0 ? 'Match in group' : 'Match'} className="input au-inline" value={group.op} onChange={(e) => onChange({ ...group, op: e.currentTarget.value as 'and' | 'or' })}>
          <option value="and">all of these</option>
          <option value="or">any of these</option>
        </select>
        {onRemove && (
          <button type="button" className="btn-sm" onClick={onRemove}>
            Remove group
          </button>
        )}
      </div>
      {group.items.map((item, i) =>
        isGroup(item) ? (
          <GroupEditor key={i} group={item} columns={columns} depth={depth + 1} onChange={(g) => set(i, g)} onRemove={() => drop(i)} />
        ) : (
          <ConditionRow key={i} value={item} columns={columns} onChange={(c) => set(i, c)} onRemove={() => drop(i)} />
        ),
      )}
      <div className="au-actions">
        <button type="button" className="btn-sm" onClick={() => onChange({ ...group, items: [...group.items, newCondition(columns)] })}>
          + Add condition
        </button>
        {depth === 0 && (
          <button type="button" className="btn-sm" onClick={() => onChange({ ...group, items: [...group.items, { op: 'or', items: [newCondition(columns)] }] })}>
            + Add group
          </button>
        )}
      </div>
    </div>
  )
}

export function ConditionsEditor({ value, columns, onChange }: { value: ConditionGroup | null; columns: readonly Column[]; onChange(g: ConditionGroup | null): void }) {
  if (!value || value.items.length === 0) {
    return (
      <div>
        <p className="au-hint">No conditions: the rule applies to every row that meets the trigger.</p>
        <button type="button" className="btn-sm" onClick={() => onChange({ op: 'and', items: [newCondition(columns)] })}>
          + Add a condition
        </button>
      </div>
    )
  }
  return (
    <>
      <GroupEditor group={value} columns={columns} depth={0} onChange={onChange} />
      <button type="button" className="btn-sm" onClick={() => onChange(null)}>
        Clear conditions
      </button>
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------------------------

export function RecipientsEditor({ value, columns, allowOwner, onChange }: { value: readonly Recipient[]; columns: readonly Column[]; allowOwner: boolean; onChange(r: Recipient[]): void }) {
  const owner = value.some((r) => r.kind === 'owner')
  const colIds = value.flatMap((r) => (r.kind === 'column' ? [r.columnId] : []))
  const [emailsText, setEmailsText] = useState(() => value.flatMap((r) => (r.kind === 'email' ? [r.email] : [])).join(', '))
  const people = columns.filter((c) => c.type === 'CONTACT_LIST')
  const emit = (nextOwner: boolean, nextCols: string[], text: string) =>
    onChange([
      ...(nextOwner && allowOwner ? [{ kind: 'owner' as const }] : []),
      ...nextCols.map((columnId) => ({ kind: 'column' as const, columnId })),
      ...text
        .split(/[,;\s]+/)
        .filter(Boolean)
        .map((email) => ({ kind: 'email' as const, email })),
    ])
  const bad = emailsText.split(/[,;\s]+/).filter((e) => e && !isEmail(e))
  return (
    <fieldset className="au-field au-wide">
      <legend className="label">Who</legend>
      {allowOwner && (
        <label className="au-check">
          <input type="checkbox" checked={owner} onChange={(e) => emit(e.currentTarget.checked, colIds, emailsText)} />
          Me, in the notification centre
        </label>
      )}
      {people.length > 0 && (
        <div className="au-checks">
          {people.map((c) => (
            <label key={c.id} className="au-check">
              <input type="checkbox" checked={colIds.includes(c.id)} onChange={(e) => emit(owner, e.currentTarget.checked ? [...colIds, c.id] : colIds.filter((x) => x !== c.id), emailsText)} />
              The people in {c.title}
            </label>
          ))}
        </div>
      )}
      <Field label="E-mail addresses" hint={bad.length ? `Not valid: ${bad.join(', ')}` : 'Separate several with commas.'}>
        {(id) => (
          <input
            id={id}
            className="input"
            type="text"
            inputMode="email"
            autoComplete="off"
            placeholder="name@example.com"
            value={emailsText}
            aria-invalid={bad.length > 0}
            onChange={(e) => {
              setEmailsText(e.currentTarget.value)
              emit(owner, colIds, e.currentTarget.value)
            }}
          />
        )}
      </Field>
    </fieldset>
  )
}

// ---------------------------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------------------------

export const ACTION_LABELS: Record<ActionType, string> = {
  notify: 'Notify people',
  update_request: 'Request an update',
  approval: 'Request an approval',
  record_date: 'Record a date',
  lock: 'Lock or unlock the row',
  move: 'Move the row to another sheet',
  copy: 'Copy the row to another sheet',
}

export function defaultAction(type: ActionType, cols: readonly Column[], otherSheets: readonly { id: string }[]): Action {
  switch (type) {
    case 'notify':
      return { type, recipients: [{ kind: 'owner' }], frequency: 'immediately', include: 'all', linkToRow: true }
    case 'update_request':
      return { type, recipients: [], columnIds: [], message: '', expiresInDays: 7 }
    case 'approval': {
      const s = cols.find((c) => c.type === 'PICKLIST') ?? cols[0]
      const opts = s?.options ?? []
      return { type, recipients: [], statusColumnId: s?.id ?? '', pendingValue: '', approvedValue: opts[0] ?? 'Approved', declinedValue: opts[1] ?? 'Declined', showColumnIds: [], message: '', expiresInDays: 7 }
    }
    case 'lock':
      return { type, locked: true }
    case 'move':
    case 'copy':
      return { type, targetSheetId: otherSheets[0]?.id ?? '' }
    case 'record_date':
      return { type, columnId: cols.find((c) => c.type === 'DATE' && c.role !== 'start' && c.role !== 'end')?.id ?? '' }
  }
}

function ColumnChecks({ legend, columns, value, onChange }: { legend: string; columns: readonly Column[]; value: readonly string[]; onChange(ids: string[]): void }) {
  return (
    <fieldset className="au-field au-wide">
      <legend className="label">{legend}</legend>
      <div className="au-checks">
        {columns.map((c) => (
          <label key={c.id} className="au-check">
            <input type="checkbox" checked={value.includes(c.id)} onChange={(e) => onChange(e.currentTarget.checked ? [...value, c.id] : value.filter((x) => x !== c.id))} />
            {c.title}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function ActionEditor({ value, columns, otherSheets, onChange }: { value: Action; columns: readonly Column[]; otherSheets: readonly { id: string; name: string }[]; onChange(a: Action): void }) {
  const requestable = columns.filter((c) => REQUESTABLE.includes(c.type) && c.role !== 'predecessor')
  return (
    <div className="au-grid">
      <Field label="Then">
        {(id) => (
          <select id={id} className="input" value={value.type} onChange={(e) => onChange(defaultAction(e.currentTarget.value as ActionType, columns, otherSheets))}>
            {(Object.keys(ACTION_LABELS) as ActionType[]).map((t) => (
              <option key={t} value={t}>
                {ACTION_LABELS[t]}
              </option>
            ))}
          </select>
        )}
      </Field>

      {value.type === 'notify' && (
        <>
          <RecipientsEditor key="notify" value={value.recipients} columns={columns} allowOwner onChange={(recipients) => onChange({ ...value, recipients })} />
          <Field label="How often" hint="E-mail can be collected into a daily or weekly digest. In-app notifications are always immediate.">
            {(id) => (
              <select id={id} className="input" value={value.frequency} onChange={(e) => onChange({ ...value, frequency: e.currentTarget.value as Frequency })}>
                <option value="immediately">Immediately</option>
                <option value="daily">Daily digest</option>
                <option value="weekly">Weekly digest</option>
              </select>
            )}
          </Field>
          <Field label="Subject (optional)">{(id) => <input id={id} className="input" value={value.subject ?? ''} placeholder="Rule name: row name" onChange={(e) => onChange({ ...value, subject: e.currentTarget.value })} />}</Field>
          <div className="au-wide">
            <Field label="Message (optional)" hint="Use {{Column title}} to insert a value from the row.">
              {(id) => <textarea id={id} className="input au-textarea" rows={3} value={value.message ?? ''} onChange={(e) => onChange({ ...value, message: e.currentTarget.value })} />}
            </Field>
          </div>
          <Field label="Include from the row">
            {(id) => (
              <select id={id} className="input" value={value.include} onChange={(e) => onChange({ ...value, include: e.currentTarget.value as 'all' | 'columns' | 'none' })}>
                <option value="all">All columns</option>
                <option value="columns">Only some columns</option>
                <option value="none">Nothing</option>
              </select>
            )}
          </Field>
          <label className="au-check au-self-end">
            <input type="checkbox" checked={value.linkToRow} onChange={(e) => onChange({ ...value, linkToRow: e.currentTarget.checked })} />
            Link to the row
          </label>
          {value.include === 'columns' && <ColumnChecks legend="Columns to include" columns={columns} value={value.columnIds ?? []} onChange={(columnIds) => onChange({ ...value, columnIds })} />}
        </>
      )}

      {value.type === 'update_request' && (
        <>
          <RecipientsEditor key="update" value={value.recipients} columns={columns} allowOwner={false} onChange={(recipients) => onChange({ ...value, recipients })} />
          <ColumnChecks legend="Columns the recipient may update" columns={requestable} value={value.columnIds} onChange={(columnIds) => onChange({ ...value, columnIds })} />
          <div className="au-wide">
            <Field label="Message (optional)" hint="Shown above the form. {{Column title}} inserts a value from the row.">
              {(id) => <textarea id={id} className="input au-textarea" rows={2} value={value.message ?? ''} onChange={(e) => onChange({ ...value, message: e.currentTarget.value })} />}
            </Field>
          </div>
          <Field label="Link valid for (days)" hint="The link works once.">
            {(id) => <input id={id} className="input" type="number" min={1} max={90} value={value.expiresInDays} onChange={(e) => onChange({ ...value, expiresInDays: Number(e.currentTarget.value) })} />}
          </Field>
        </>
      )}

      {value.type === 'approval' && (
        <>
          <RecipientsEditor key="approval" value={value.recipients} columns={columns} allowOwner={false} onChange={(recipients) => onChange({ ...value, recipients })} />
          <Field label="Write the answer to">
            {(id) => <ColumnSelect id={id} columns={columns} filter={(c) => REQUESTABLE.includes(c.type)} value={value.statusColumnId} onChange={(statusColumnId) => onChange({ ...value, statusColumnId })} />}
          </Field>
          {(['pendingValue', 'approvedValue', 'declinedValue'] as const).map((k) => {
            const status = columns.find((c) => c.id === value.statusColumnId)
            const label = k === 'pendingValue' ? 'While waiting (optional)' : k === 'approvedValue' ? 'If approved' : 'If declined'
            return (
              <Field key={k} label={label}>
                {(id) =>
                  status?.type === 'PICKLIST' ? (
                    <select id={id} className="input" value={value[k] ?? ''} onChange={(e) => onChange({ ...value, [k]: e.currentTarget.value })}>
                      {k === 'pendingValue' && <option value="">Leave as it is</option>}
                      {(status.options ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input id={id} className="input" value={value[k] ?? ''} onChange={(e) => onChange({ ...value, [k]: e.currentTarget.value })} />
                  )
                }
              </Field>
            )
          })}
          <ColumnChecks legend="Columns shown to the approver (read only)" columns={columns} value={value.showColumnIds ?? []} onChange={(showColumnIds) => onChange({ ...value, showColumnIds })} />
          <div className="au-wide">
            <Field label="Message (optional)">{(id) => <textarea id={id} className="input au-textarea" rows={2} value={value.message ?? ''} onChange={(e) => onChange({ ...value, message: e.currentTarget.value })} />}</Field>
          </div>
          <Field label="Link valid for (days)" hint="The link works once.">
            {(id) => <input id={id} className="input" type="number" min={1} max={90} value={value.expiresInDays} onChange={(e) => onChange({ ...value, expiresInDays: Number(e.currentTarget.value) })} />}
          </Field>
        </>
      )}

      {value.type === 'record_date' && (
        <Field label="Date column" hint="Start and End dates belong to the schedule and cannot be chosen.">
          {(id) => <ColumnSelect id={id} columns={columns} filter={(c) => c.type === 'DATE' && c.role !== 'start' && c.role !== 'end'} value={value.columnId} onChange={(columnId) => onChange({ ...value, columnId })} placeholder="Choose a date column" />}
        </Field>
      )}

      {value.type === 'lock' && (
        <Field label="Lock state">
          {(id) => (
            <select id={id} className="input" value={value.locked ? 'lock' : 'unlock'} onChange={(e) => onChange({ type: 'lock', locked: e.currentTarget.value === 'lock' })}>
              <option value="lock">Lock the row</option>
              <option value="unlock">Unlock the row</option>
            </select>
          )}
        </Field>
      )}

      {(value.type === 'move' || value.type === 'copy') && (
        <Field label="Target sheet" hint="Cells go to columns with the same name and type. A row with sub-rows cannot be moved.">
          {(id) =>
            otherSheets.length === 0 ? (
              <p className="au-hint">You have no other sheet yet.</p>
            ) : (
              <select id={id} className="input" value={value.targetSheetId} onChange={(e) => onChange({ ...value, targetSheetId: e.currentTarget.value })}>
                <option value="" disabled>
                  Choose a sheet
                </option>
                {otherSheets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )
          }
        </Field>
      )}
    </div>
  )
}
