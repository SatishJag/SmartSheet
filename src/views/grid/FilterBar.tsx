import type { Column } from '../../model/validate'
import { FILTER_OPS, isValueless, type FilterOp, type FilterSpec } from './viewModel'

interface FilterBarProps {
  columns: Column[]
  /** The current filter; null shows defaults (first column, "contains", no value). */
  filter: FilterSpec | null
  onChange(filter: FilterSpec | null): void
}

/** One filter: column, operator, value (hidden for is empty / is not empty), and Clear. */
export function FilterBar({ columns, filter, onChange }: FilterBarProps) {
  const current: FilterSpec = filter ?? { colId: columns[0]?.id ?? '', op: 'contains', value: '' }
  const update = (patch: Partial<FilterSpec>) => onChange({ ...current, ...patch })
  return (
    <div className="filter-bar" role="search" aria-label="Filter rows">
      <select aria-label="Filter column" value={current.colId} onChange={(e) => update({ colId: e.target.value })}>
        {columns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </select>
      <select
        aria-label="Filter operator"
        value={current.op}
        onChange={(e) => update({ op: e.target.value as FilterOp })}
      >
        {FILTER_OPS.map((o) => (
          <option key={o.op} value={o.op}>
            {o.label}
          </option>
        ))}
      </select>
      {!isValueless(current.op) && (
        <input
          type="search"
          aria-label="Filter value"
          placeholder="Filter value"
          value={current.value}
          onChange={(e) => update({ value: e.target.value })}
        />
      )}
      <button type="button" onClick={() => onChange(null)} disabled={filter === null}>
        Clear
      </button>
    </div>
  )
}
