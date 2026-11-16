import { useId, useState, type ReactNode } from 'react'
import { facetOptions, type Facet, type FilterState } from './filters'
import type { SavedView, ViewPage } from './types'

export function SavedViews({
  page,
  views,
  activeId,
  onApply,
  onSave,
  onDelete,
}: {
  page: ViewPage
  views: SavedView[]
  activeId: string | null
  onApply: (view: SavedView) => void
  onSave: (name: string) => Promise<string | null>
  onDelete: (id: string) => Promise<string | null>
}) {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mine = views.filter((v) => v.page === page)

  async function save() {
    const n = name.trim()
    if (!n) return setError('Enter a name for the view')
    const err = await onSave(n)
    if (err) return setError(err)
    setNaming(false)
    setName('')
    setError(null)
  }

  return (
    <section className="rm-side-section" aria-label="My views">
      <h3>My Views</h3>
      <ul className="rm-side-list">
        {mine.map((v) => (
          <li key={v.id} className="rm-view-item">
            <button type="button" className={`rm-side-link${v.id === activeId ? ' is-active' : ''}`} onClick={() => onApply(v)}>
              {v.name}
            </button>
            <button type="button" className="rm-icon-button" aria-label={`Delete view ${v.name}`} onClick={() => void onDelete(v.id)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      {naming ? (
        <div className="rm-view-name">
          <input
            aria-label="View name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
              if (e.key === 'Escape') setNaming(false)
            }}
            autoFocus
          />
          <button type="button" onClick={() => void save()}>
            Save
          </button>
        </div>
      ) : (
        <button type="button" className="rm-side-link rm-muted" onClick={() => setNaming(true)}>
          + Save Current View
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

export function FacetFilters<T>({
  title,
  facets,
  items,
  state,
  onChange,
  children,
}: {
  title: string
  facets: Facet<T>[]
  items: readonly T[]
  state: FilterState
  onChange: (next: FilterState) => void
  children?: ReactNode
}) {
  const anyActive = facets.some((f) => state[f.key])
  return (
    <section className="rm-side-section" aria-label={title}>
      <h3>{title}</h3>
      <button
        type="button"
        className={`rm-side-link${anyActive ? '' : ' is-active'}`}
        onClick={() => onChange(Object.fromEntries(Object.entries(state).filter(([k]) => !facets.some((f) => f.key === k))))}
      >
        Everyone
      </button>
      {children}
      {facets.map((f) => (
        <FacetSelect key={f.key} facet={f} items={items} value={state[f.key] ?? ''} onChange={(v) => onChange({ ...state, [f.key]: v })} />
      ))}
    </section>
  )
}

function FacetSelect<T>({ facet, items, value, onChange }: { facet: Facet<T>; items: readonly T[]; value: string; onChange: (v: string) => void }) {
  const id = useId()
  const options = facetOptions(facet, items)
  // Keep a chosen value listed even if no record has it any more.
  if (value && !options.some((o) => o.value === value)) options.push({ value, label: facet.display?.(value) ?? value })
  return (
    <div className="rm-facet">
      <label htmlFor={id}>{facet.label}:</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={value ? 'is-set' : ''}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}
