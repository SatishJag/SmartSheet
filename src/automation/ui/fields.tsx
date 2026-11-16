/** Small form pieces shared by the rule builder's editors. */
import { useId, type ReactNode } from 'react'
import type { Column } from '../../model/validate'
import { CONDITION_OPS } from '../conditions'
import type { ConditionOp } from '../types'

export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className="au-field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint && <p className="au-hint">{hint}</p>}
    </div>
  )
}

export function ColumnSelect({
  id,
  label,
  columns,
  value,
  onChange,
  filter,
  placeholder = 'Choose a column',
}: {
  id?: string
  label?: string
  columns: readonly Column[]
  value: string
  onChange(id: string): void
  filter?: (c: Column) => boolean
  placeholder?: string
}) {
  const list = filter ? columns.filter(filter) : columns
  return (
    <select id={id} aria-label={label} className="input" value={list.some((c) => c.id === value) ? value : ''} onChange={(e) => onChange(e.currentTarget.value)}>
      <option value="" disabled>
        {placeholder}
      </option>
      {list.map((c) => (
        <option key={c.id} value={c.id}>
          {c.title}
        </option>
      ))}
    </select>
  )
}

/** An input fitting the column's type, for the value a condition or trigger compares with. */
export function ValueInput({ id, label, column, value, onChange }: { id?: string; label?: string; column: Column | undefined; value: unknown; onChange(v: unknown): void }) {
  if (column?.type === 'PICKLIST' || column?.type === 'MULTI_PICKLIST') {
    return (
      <select id={id} aria-label={label} className="input" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.currentTarget.value)}>
        <option value="" disabled>
          Choose a value
        </option>
        {(column.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }
  if (column?.type === 'CHECKBOX') {
    return (
      <select id={id} aria-label={label} className="input" value={value === false ? 'false' : 'true'} onChange={(e) => onChange(e.currentTarget.value === 'true')}>
        <option value="true">Checked</option>
        <option value="false">Not checked</option>
      </select>
    )
  }
  return <input id={id} aria-label={label} className="input" type={column?.type === 'DATE' ? 'date' : 'text'} value={value == null ? '' : String(value)} onChange={(e) => onChange(e.currentTarget.value)} />
}

const DATE_ONLY: ConditionOp[] = ['is_today', 'is_past', 'is_future', 'in_next_days']
const ORDERED: ConditionOp[] = ['gt', 'lt', 'gte', 'lte']

/** The operators that make sense for a column of this type. */
export function opsFor(col: Column | undefined): { op: ConditionOp; label: string; needsValue: boolean }[] {
  return CONDITION_OPS.filter(({ op }) => {
    if (!col) return true
    if (DATE_ONLY.includes(op)) return col.type === 'DATE'
    if (ORDERED.includes(op)) return col.type === 'DATE' || col.type === 'TEXT_NUMBER' || col.type === 'DURATION'
    if (op === 'contains' || op === 'not_contains') return col.type !== 'CHECKBOX' && col.type !== 'PICKLIST' && col.type !== 'DATE'
    if (col.type === 'MULTI_PICKLIST' && (op === 'is' || op === 'is_not')) return false
    return true
  })
}
