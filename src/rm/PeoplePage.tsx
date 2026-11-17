import { useMemo, useState } from 'react'
import { applyFacets, matchesSearch, PEOPLE_FACETS, personSearchText, sortPeople, type FilterState, type PersonSort } from './filters'
import { FacetFilters, SavedViews } from './Sidebar'
import { fullName, OFFICE_STATUS_LABELS, type Person, type SavedView } from './types'
import type { RmActions } from './useRmData'
import { Avatar } from './Avatar'
import { availability, byPerson, formatPercent } from './metrics'
import { endOfWeek } from './dates'
import type { RmData } from './api'

interface PeopleViewState {
  filters: FilterState
  sort: PersonSort
  descending: boolean
}

export function PeoplePage({
  data,
  actions,
  today,
  search,
  onAdd,
  onEdit,
}: {
  data: RmData
  actions: RmActions
  today: string
  search: string
  onAdd: () => void
  onEdit: (p: Person) => void
}) {
  const [view, setView] = useState<PeopleViewState>({ filters: {}, sort: 'first', descending: false })
  const [activeView, setActiveView] = useState<string | null>(null)
  const assignmentsByPerson = useMemo(() => byPerson(data.assignments), [data.assignments])

  const shown = useMemo(() => {
    const filtered = applyFacets(data.people, PEOPLE_FACETS, view.filters).filter((p) => matchesSearch(personSearchText(p), search))
    return sortPeople(filtered, view.sort, view.descending)
  }, [data.people, view, search])

  const change = (next: Partial<PeopleViewState>) => {
    setView((v) => ({ ...v, ...next }))
    setActiveView(null)
  }
  const sortBy = (sort: PersonSort) => change({ sort, descending: view.sort === sort ? !view.descending : false })
  const arrow = (sort: PersonSort) => (view.sort === sort ? (view.descending ? ' ▼' : ' ▲') : '')

  return (
    <div className="rm-page">
      <aside className="rm-sidebar">
        <SavedViews
          page="people"
          views={data.views}
          activeId={activeView}
          onApply={(v: SavedView) => {
            setView({ filters: {}, sort: 'first', descending: false, ...(v.state as Partial<PeopleViewState>) })
            setActiveView(v.id)
          }}
          onSave={(name) => actions.saveView({ page: 'people', name, state: { ...view } })}
          onDelete={actions.deleteView}
        />
        <FacetFilters title="Show" facets={PEOPLE_FACETS} items={data.people} state={view.filters} onChange={(filters) => change({ filters })} />
      </aside>
      <section className="rm-content">
        <div className="rm-content-head">
          <div>
            <h1>People</h1>
            <p className="rm-muted">
              {shown.length} matching {shown.length === 1 ? 'person' : 'people'}
            </p>
          </div>
          <button type="button" className="rm-primary" onClick={onAdd}>
            Add person
          </button>
        </div>
        {data.people.length === 0 ? (
          <p className="rm-empty">No people yet. Add your team to start scheduling them on projects.</p>
        ) : (
          <table className="rm-table">
            <thead>
              <tr>
                <th aria-label="Photo" />
                <th aria-sort={view.sort === 'first' ? (view.descending ? 'descending' : 'ascending') : undefined}>
                  <button type="button" className="rm-sort" onClick={() => sortBy('first')}>
                    First Name{arrow('first')}
                  </button>{' '}
                  <button type="button" className="rm-sort rm-muted" onClick={() => sortBy('last')}>
                    Last Name{arrow('last')}
                  </button>
                </th>
                <th>Role</th>
                <th>Discipline</th>
                <th>Location</th>
                <th>Office Status</th>
                <th>Available this week</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Avatar person={p} />
                  </td>
                  <td>
                    <button type="button" className="rm-row-link" onClick={() => onEdit(p)}>
                      {fullName(p)}
                    </button>
                    {p.email && <div className="rm-muted rm-small">{p.email}</div>}
                  </td>
                  <td>{p.role ?? '--'}</td>
                  <td>{p.discipline ?? '--'}</td>
                  <td>{p.location ?? '--'}</td>
                  <td>{p.office_status ? OFFICE_STATUS_LABELS[p.office_status] : '--'}</td>
                  <td>{formatPercent(availability(assignmentsByPerson.get(p.id) ?? [], today, endOfWeek(today)))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
