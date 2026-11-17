import { useMemo, useState } from 'react'
import type { RmData } from './api'
import { usDate } from './dates'
import { applyFacets, matchesSearch, projectFacets, type FilterState } from './filters'
import { formatDays, formatMoney, projectTracking } from './metrics'
import { FacetFilters, SavedViews } from './Sidebar'
import { fullName, PROJECT_TYPE_LABELS, type Project } from './types'
import type { RmActions } from './useRmData'

type SortKey = 'name' | 'client' | 'type' | 'starts' | 'ends' | 'owner'

interface ProjectsViewState {
  filters: FilterState
  sort: SortKey
  descending: boolean
  layout: 'list' | 'cards'
}

const DEFAULT_VIEW: ProjectsViewState = { filters: { state: 'active' }, sort: 'name', descending: false, layout: 'list' }

export function ProjectsPage({
  data,
  actions,
  today,
  search,
  sheetNames,
  onAdd,
  onEdit,
  onOpenSheet,
}: {
  data: RmData
  actions: RmActions
  today: string
  search: string
  sheetNames: ReadonlyMap<string, string>
  onAdd: () => void
  onEdit: (p: Project) => void
  onOpenSheet: (sheetId: string) => void
}) {
  const [view, setView] = useState<ProjectsViewState>(DEFAULT_VIEW)
  const [activeView, setActiveView] = useState<string | null>(null)
  const people = useMemo(() => new Map(data.people.map((p) => [p.id, p])), [data.people])
  const facets = useMemo(() => projectFacets(people), [people])
  const ownerName = (p: Project) => {
    const o = p.project_owner_id ? people.get(p.project_owner_id) : undefined
    return o ? fullName(o) : ''
  }

  const shown = useMemo(() => {
    const key = (p: Project): string => {
      switch (view.sort) {
        case 'name':
          return p.name.toLowerCase()
        case 'client':
          return (p.client ?? '￿').toLowerCase()
        case 'type':
          return p.project_type
        case 'starts':
          return p.starts_at
        case 'ends':
          return p.ends_at
        case 'owner':
          return ownerName(p).toLowerCase() || '￿'
      }
    }
    const list = applyFacets(data.projects, facets, view.filters)
      .filter((p) => matchesSearch(`${p.name} ${p.client ?? ''} ${p.tags.join(' ')}`, search))
      .sort((a, b) => key(a).localeCompare(key(b)) || a.name.localeCompare(b.name))
    return view.descending ? list.reverse() : list
  }, [data.projects, facets, view, search, people])

  const change = (next: Partial<ProjectsViewState>) => {
    setView((v) => ({ ...v, ...next }))
    setActiveView(null)
  }
  const header = (key: SortKey, label: string) => (
    <th aria-sort={view.sort === key ? (view.descending ? 'descending' : 'ascending') : undefined}>
      <button type="button" className="rm-sort" onClick={() => change({ sort: key, descending: view.sort === key ? !view.descending : false })}>
        {label}
        {view.sort === key ? (view.descending ? ' ▼' : ' ▲') : ''}
      </button>
    </th>
  )

  const budgetText = (p: Project) => {
    const t = projectTracking(p, data.assignments, people, today)
    if (t.remaining === null || t.budget === null) return '--'
    const unit = p.budget_type === 'days' ? (n: number) => `${formatDays(n)} days` : formatMoney
    return t.remaining >= 0 ? `${unit(t.remaining)} remaining` : `${unit(-t.remaining)} over budget`
  }

  return (
    <div className="rm-page">
      <aside className="rm-sidebar">
        <SavedViews
          page="projects"
          views={data.views}
          activeId={activeView}
          onApply={(v) => {
            setView({ ...DEFAULT_VIEW, ...(v.state as Partial<ProjectsViewState>) })
            setActiveView(v.id)
          }}
          onSave={(name) => actions.saveView({ page: 'projects', name, state: { ...view } })}
          onDelete={actions.deleteView}
        />
        <FacetFilters title="Show" facets={facets} items={data.projects} state={view.filters} onChange={(filters) => change({ filters })} />
      </aside>
      <section className="rm-content">
        <div className="rm-content-head">
          <div>
            <h1>Project Portfolio</h1>
            <p className="rm-muted">
              {shown.length} matching {shown.length === 1 ? 'project' : 'projects'}
            </p>
          </div>
          <div className="rm-head-actions">
            <div className="rm-segmented" role="group" aria-label="Layout">
              <button type="button" aria-pressed={view.layout === 'list'} onClick={() => change({ layout: 'list' })}>
                List
              </button>
              <button type="button" aria-pressed={view.layout === 'cards'} onClick={() => change({ layout: 'cards' })}>
                Cards
              </button>
            </div>
            <button type="button" className="rm-primary" onClick={onAdd}>
              New Project
            </button>
          </div>
        </div>
        {data.projects.length === 0 ? (
          <p className="rm-empty">No projects yet. Create one, or add work from one of your sheets.</p>
        ) : view.layout === 'list' ? (
          <table className="rm-table">
            <thead>
              <tr>
                {header('name', 'Project Name')}
                {header('client', 'Client Name')}
                {header('type', 'Project Type')}
                {header('starts', 'Starts At')}
                {header('ends', 'Ends At')}
                {header('owner', 'Project Owner')}
                <th>Budget</th>
                <th>Sheet</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} className={p.state === 'archived' ? 'is-archived' : undefined}>
                  <td>
                    <button type="button" className="rm-row-link" onClick={() => onEdit(p)}>
                      {p.name}
                    </button>
                  </td>
                  <td>{p.client ?? '--'}</td>
                  <td>
                    <span className={`rm-swatch is-${p.project_type}`} aria-hidden="true" />
                    {PROJECT_TYPE_LABELS[p.project_type]}
                  </td>
                  <td>{usDate(p.starts_at)}</td>
                  <td>{usDate(p.ends_at)}</td>
                  <td>{ownerName(p) || '[none]'}</td>
                  <td>{budgetText(p)}</td>
                  <td>
                    {p.sheet_id ? (
                      <button type="button" className="link-button" onClick={() => onOpenSheet(p.sheet_id!)}>
                        {sheetNames.get(p.sheet_id) ?? 'Open sheet'}
                      </button>
                    ) : (
                      '--'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <ul className="rm-cards">
            {shown.map((p) => (
              <li key={p.id}>
                <button type="button" className={`rm-card is-${p.project_type}`} onClick={() => onEdit(p)}>
                  <strong>{p.name}</strong>
                  <span className="rm-muted">{p.client ?? 'No client'}</span>
                  <span>
                    {usDate(p.starts_at)} – {usDate(p.ends_at)}
                  </span>
                  <span className="rm-small">{budgetText(p)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
