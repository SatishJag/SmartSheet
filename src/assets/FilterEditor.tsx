import { useId } from 'react'
import type { ColumnType } from '../model/validate'
import { AssetIcon } from './AssetIcon'
import { MAX_CONDITIONS } from './definition'
import type { Condition, FilterOp, ReportFilter } from './types'

export interface FilterColumn {
  key: string
  title: string
  type: ColumnType
  options?: string[]
}

const LABELS: Record<FilterOp, string> = {
  is: 'is',
  isNot: 'is not',
  contains: 'contains',
  notContains: 'does not contain',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  between: 'is between',
  blank: 'is blank',
  notBlank: 'is not blank',
  lastDays: 'is in the last (days)',
  nextDays: 'is in the next (days)',
}

const DATE_LABELS: Partial<Record<FilterOp, string>> = {
  gt: 'is after',
  gte: 'is on or after',
  lt: 'is before',
  lte: 'is on or before',
}

/** The conditions that make sense for a column type, in the order users reach for them. */
export function opsFor(type: ColumnType | undefined): FilterOp[] {
  switch (type) {
    case 'CHECKBOX':
      return ['is']
    case 'DATE':
      return ['is', 'isNot', 'lt', 'gt', 'lte', 'gte', 'between', 'lastDays', 'nextDays', 'blank', 'notBlank']
    case 'PICKLIST':
    case 'MULTI_PICKLIST':
      return ['is', 'isNot', 'contains', 'blank', 'notBlank']
    case 'CONTACT_LIST':
      return ['is', 'isNot', 'contains', 'notContains', 'blank', 'notBlank']
    case 'DURATION':
    case 'PREDECESSOR':
      return ['is', 'isNot', 'contains', 'gt', 'lt', 'blank', 'notBlank']
    default:
      return ['is', 'isNot', 'contains', 'notContains', 'gt', 'gte', 'lt', 'lte', 'between', 'blank', 'notBlank']
  }
}

export const opLabel = (op: FilterOp, type?: ColumnType) => (type === 'DATE' ? DATE_LABELS[op] : undefined) ?? LABELS[op]

const NO_VALUE: FilterOp[] = ['blank', 'notBlank']

interface Props {
  columns: FilterColumn[]
  value: ReportFilter
  onChange: (next: ReportFilter) => void
  /** Used in accessible names ("Filter 1 column"). */
  what?: string
}

/**
 * Edits a report filter: match ALL or ANY of a list of conditions, each "column, condition, value(s)".
 * Used by the report builder and by every dashboard widget that reads data.
 */
export function FilterEditor({ columns, value, onChange, what = 'Filter' }: Props) {
  const listId = useId()
  const byKey = new Map(columns.map((c) => [c.key, c]))

  const update = (i: number, patch: Partial<Condition>) =>
    onChange({ ...value, conditions: value.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) })

  function changeColumn(i: number, key: string) {
    const col = byKey.get(key)
    const cond = value.conditions[i]
    const op = opsFor(col?.type).includes(cond.op) ? cond.op : 'is'
    update(i, { column: key, op, value: col?.type === 'CHECKBOX' ? 'true' : '', value2: '' })
  }

  function add() {
    const first = columns[0]
    if (!first) return
    onChange({ ...value, conditions: [...value.conditions, { column: first.key, op: 'is', value: first.type === 'CHECKBOX' ? 'true' : '', value2: '' }] })
  }

  return (
    <div className="filter-editor">
      {value.conditions.length > 1 && (
        <div className="filter-match" role="group" aria-label={`${what}: how the conditions combine`}>
          <span>Show rows that match</span>
          <div className="segmented segmented-sm">
            {(['all', 'any'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={value.match === m} onClick={() => onChange({ ...value, match: m })}>
                {m === 'all' ? 'all conditions' : 'any condition'}
              </button>
            ))}
          </div>
        </div>
      )}
      <ul className="filter-list">
        {value.conditions.map((c, i) => {
          const col = byKey.get(c.column)
          const type = col?.type
          const ops = opsFor(type)
          const name = `${what} ${i + 1}`
          return (
            <li key={i} className="filter-row">
              <select aria-label={`${name} column`} value={c.column} onChange={(e) => changeColumn(i, e.target.value)}>
                {!col && <option value={c.column}>{c.column.replace(/^c:/, '')} (missing)</option>}
                {columns.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.title}
                  </option>
                ))}
              </select>
              <select aria-label={`${name} condition`} value={c.op} onChange={(e) => update(i, { op: e.target.value as FilterOp })}>
                {(ops.includes(c.op) ? ops : [c.op, ...ops]).map((op) => (
                  <option key={op} value={op}>
                    {opLabel(op, type)}
                  </option>
                ))}
              </select>
              {!NO_VALUE.includes(c.op) && (
                <ValueInput
                  cond={c}
                  type={type}
                  options={col?.options}
                  name={name}
                  listId={`${listId}-dates`}
                  onChange={(patch) => update(i, patch)}
                />
              )}
              <button
                type="button"
                className="btn-icon is-danger"
                aria-label={`Remove ${name.toLowerCase()}`}
                onClick={() => onChange({ ...value, conditions: value.conditions.filter((_, j) => j !== i) })}
              >
                <AssetIcon name="close" size={16} />
              </button>
            </li>
          )
        })}
      </ul>
      <datalist id={`${listId}-dates`}>
        <option value="today" />
        <option value="today+7" />
        <option value="today-7" />
        <option value="today+30" />
      </datalist>
      <button type="button" className="btn btn-sm" onClick={add} disabled={columns.length === 0 || value.conditions.length >= MAX_CONDITIONS}>
        <AssetIcon name="plus" size={16} />
        Add filter
      </button>
    </div>
  )
}

function ValueInput({
  cond,
  type,
  options,
  name,
  listId,
  onChange,
}: {
  cond: Condition
  type: ColumnType | undefined
  options: string[] | undefined
  name: string
  listId: string
  onChange: (patch: Partial<Condition>) => void
}) {
  if (type === 'CHECKBOX') {
    return (
      <select aria-label={`${name} value`} value={cond.value || 'true'} onChange={(e) => onChange({ value: e.target.value })}>
        <option value="true">checked</option>
        <option value="false">not checked</option>
      </select>
    )
  }
  if ((type === 'PICKLIST' || type === 'MULTI_PICKLIST') && options && options.length > 0 && cond.op !== 'contains') {
    return (
      <select aria-label={`${name} value`} value={cond.value} onChange={(e) => onChange({ value: e.target.value })}>
        <option value="">Choose…</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }
  const isDate = type === 'DATE' && cond.op !== 'lastDays' && cond.op !== 'nextDays'
  const numeric = cond.op === 'lastDays' || cond.op === 'nextDays'
  const common = {
    list: isDate ? listId : undefined,
    placeholder: isDate ? 'YYYY-MM-DD or today' : numeric ? 'days' : 'value',
    inputMode: numeric ? ('numeric' as const) : undefined,
  }
  return (
    <>
      <input type="text" aria-label={`${name} value`} value={cond.value} onChange={(e) => onChange({ value: e.target.value })} {...common} />
      {cond.op === 'between' && (
        <>
          <span className="filter-and">and</span>
          <input type="text" aria-label={`${name} second value`} value={cond.value2} onChange={(e) => onChange({ value2: e.target.value })} {...common} />
        </>
      )}
    </>
  )
}
