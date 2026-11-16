import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { RmData } from './api'
import { Avatar } from './Avatar'
import { addDays, addMonths, isoWeek, shortDate } from './dates'
import { applyFacets, PEOPLE_FACETS, sortPeople, type FilterState, type PersonSort } from './filters'
import { allocationSegments, averageAllocation, byPerson, formatPercent, heatLevel, periods as buildPeriods, type Period, type Zoom } from './metrics'
import { FacetFilters, SavedViews } from './Sidebar'
import { COLUMN_WIDTH, dateAt, PERIOD_COUNT, pxPerDay, xOf } from './timeline'
import { fullName, PROJECT_TYPE_LABELS, type Assignment, type AssignmentInput, type Person, type Project } from './types'
import type { RmActions } from './useRmData'

type Mode = 'people' | 'projects'
type Display = 'details' | 'heatmap'

interface ScheduleViewState {
  filters: FilterState
  sort: PersonSort
  zoom: Zoom
  mode: Mode
  display: Display
  /** '' = all projects. */
  project: string
  projectType: string
}

const DEFAULT_VIEW: ScheduleViewState = { filters: {}, sort: 'first', zoom: 'week', mode: 'people', display: 'details', project: '', projectType: '' }

export interface ScheduleProps {
  data: RmData
  actions: RmActions
  today: string
  search: string
  onNewAssignment: (initial: Partial<AssignmentInput>) => void
  onEditAssignment: (a: Assignment) => void
}

export function SchedulePage({ data, actions, today, search, onNewAssignment, onEditAssignment }: ScheduleProps) {
  const [view, setView] = useState<ScheduleViewState>(DEFAULT_VIEW)
  const [activeView, setActiveView] = useState<string | null>(null)
  const [anchor, setAnchor] = useState(today)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  // Undo / redo of moves and resizes made by dragging on the timeline.
  const [undo, setUndo] = useState<{ before: Assignment; after: Assignment }[]>([])
  const [redo, setRedo] = useState<{ before: Assignment; after: Assignment }[]>([])

  const width = COLUMN_WIDTH[view.zoom]
  const periods = useMemo(() => buildPeriods(anchor, PERIOD_COUNT[view.zoom], view.zoom), [anchor, view.zoom])
  const rangeStart = periods[0].start
  const rangeEnd = periods[periods.length - 1].end
  const totalWidth = periods.length * width

  const projectsById = useMemo(() => new Map(data.projects.map((p) => [p.id, p])), [data.projects])
  const peopleById = useMemo(() => new Map(data.people.map((p) => [p.id, p])), [data.people])

  // Assignments that pass the project filters.
  const assignments = useMemo(
    () =>
      data.assignments.filter((a) => {
        const p = projectsById.get(a.project_id)
        if (!p) return false
        if (view.project && a.project_id !== view.project) return false
        if (view.projectType && p.project_type !== view.projectType) return false
        return true
      }),
    [data.assignments, projectsById, view.project, view.projectType],
  )
  const byPersonAll = useMemo(() => byPerson(data.assignments), [data.assignments])
  const byPersonShown = useMemo(() => byPerson(assignments), [assignments])

  const people = useMemo(() => {
    let list = applyFacets(data.people, PEOPLE_FACETS, view.filters)
    const q = search.trim().toLowerCase()
    if (q) list = list.filter((p) => fullName(p).toLowerCase().includes(q))
    return sortPeople(list, view.sort)
  }, [data.people, view.filters, view.sort, search])

  const projects = useMemo(() => {
    const q = search.trim().toLowerCase()
    return data.projects
      .filter((p) => p.state === 'active')
      .filter((p) => !view.project || p.id === view.project)
      .filter((p) => !view.projectType || p.project_type === view.projectType)
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.name.localeCompare(b.name))
  }, [data.projects, view.project, view.projectType, search])

  const change = (next: Partial<ScheduleViewState>) => {
    setView((v) => ({ ...v, ...next }))
    setActiveView(null)
  }

  const step = (dir: 1 | -1) => {
    const n = Math.max(1, Math.floor(PERIOD_COUNT[view.zoom] / 2))
    setAnchor((a) => (view.zoom === 'month' ? addMonths(a, dir * n) : addDays(a, dir * n * (view.zoom === 'week' ? 7 : 1))))
  }

  const toggle = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  async function saveMove(before: Assignment, after: Assignment, record = true) {
    const { id, created_at: _c, ...input } = after
    void _c
    const err = await actions.saveAssignment(input, id)
    setError(err)
    if (!err && record) {
      setUndo((u) => [...u, { before, after }])
      setRedo([])
    }
    return err
  }
  async function doUndo() {
    const last = undo[undo.length - 1]
    if (!last) return
    if (!(await saveMove(last.after, last.before, false))) {
      setUndo((u) => u.slice(0, -1))
      setRedo((r) => [...r, last])
    }
  }
  async function doRedo() {
    const last = redo[redo.length - 1]
    if (!last) return
    if (!(await saveMove(last.before, last.after, false))) {
      setRedo((r) => r.slice(0, -1))
      setUndo((u) => [...u, last])
    }
  }

  const geometry = { periods, width, zoom: view.zoom }

  return (
    <div className="rm-page">
      <aside className="rm-sidebar">
        <section className="rm-side-section" aria-label="Display">
          <h3>Group by</h3>
          <div className="rm-segmented is-stacked" role="group" aria-label="Group by">
            <button type="button" aria-pressed={view.mode === 'people'} onClick={() => change({ mode: 'people' })}>
              People
            </button>
            <button type="button" aria-pressed={view.mode === 'projects'} onClick={() => change({ mode: 'projects' })}>
              Projects
            </button>
          </div>
          <h3>Show</h3>
          <div className="rm-segmented is-stacked" role="group" aria-label="Show">
            <button type="button" aria-pressed={view.display === 'details'} onClick={() => change({ display: 'details' })}>
              Assignment Details
            </button>
            <button type="button" aria-pressed={view.display === 'heatmap'} onClick={() => change({ display: 'heatmap' })}>
              Allocation Heatmap
            </button>
          </div>
          <div className="rm-facet">
            <label htmlFor="rm-sched-sort">Sort By:</label>
            <select id="rm-sched-sort" value={view.sort} onChange={(e) => change({ sort: e.target.value as PersonSort })}>
              <option value="first">First Name</option>
              <option value="last">Last Name</option>
            </select>
          </div>
        </section>
        <SavedViews
          page="schedule"
          views={data.views}
          activeId={activeView}
          onApply={(v) => {
            setView({ ...DEFAULT_VIEW, ...(v.state as Partial<ScheduleViewState>) })
            setActiveView(v.id)
          }}
          onSave={(name) => actions.saveView({ page: 'schedule', name, state: { ...view } })}
          onDelete={actions.deleteView}
        />
        <FacetFilters title="People Filters" facets={PEOPLE_FACETS} items={data.people} state={view.filters} onChange={(filters) => change({ filters })} />
        <section className="rm-side-section" aria-label="Project filters">
          <h3>Project Filters</h3>
          <div className="rm-facet">
            <label htmlFor="rm-sched-project">Project:</label>
            <select id="rm-sched-project" value={view.project} onChange={(e) => change({ project: e.target.value })} className={view.project ? 'is-set' : ''}>
              <option value="">All</option>
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="rm-facet">
            <label htmlFor="rm-sched-ptype">Project Type:</label>
            <select id="rm-sched-ptype" value={view.projectType} onChange={(e) => change({ projectType: e.target.value })} className={view.projectType ? 'is-set' : ''}>
              <option value="">All</option>
              {Object.entries(PROJECT_TYPE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </section>
      </aside>

      <section className="rm-content rm-schedule">
        <div className="rm-schedule-toolbar">
          <button type="button" aria-label="Earlier" onClick={() => step(-1)}>
            ‹
          </button>
          <button type="button" onClick={() => setAnchor(today)}>
            Today
          </button>
          <button type="button" aria-label="Later" onClick={() => step(1)}>
            ›
          </button>
          <button type="button" aria-label="Undo" disabled={undo.length === 0} onClick={() => void doUndo()}>
            ↶
          </button>
          <button type="button" aria-label="Redo" disabled={redo.length === 0} onClick={() => void doRedo()}>
            ↷
          </button>
          <div className="rm-segmented" role="group" aria-label="Zoom">
            {(['day', 'week', 'month'] as const).map((z) => (
              <button key={z} type="button" aria-pressed={view.zoom === z} title={z} onClick={() => change({ zoom: z })}>
                {z.charAt(0).toUpperCase()}
              </button>
            ))}
          </div>
          <span className="rm-muted rm-small">
            {shortDate(rangeStart)} – {shortDate(rangeEnd)}
          </span>
          <span className="rm-spacer" />
          <button
            type="button"
            className="rm-primary"
            disabled={data.people.length === 0 || data.projects.length === 0}
            title={data.people.length === 0 || data.projects.length === 0 ? 'Add a person and a project first' : undefined}
            onClick={() => onNewAssignment({ starts_at: today, ends_at: addDays(today, 4), project_id: view.project || undefined })}
          >
            Assign
          </button>
        </div>
        {error && <p role="alert">{error}</p>}

        <div className="rm-timeline" role="grid" aria-label="Resource schedule">
          <div className="rm-tl-row rm-tl-head" role="row">
            <div className="rm-tl-label" role="columnheader">
              {view.mode === 'people' ? 'People' : 'Projects'}
            </div>
            <div className="rm-tl-lane" style={{ width: totalWidth }}>
              {periods.map((p) => (
                <div key={p.start} role="columnheader" className={`rm-tl-col${p.start <= today && today <= p.end ? ' is-today' : ''}`} style={{ width }}>
                  <strong>{periodTitle(p, view.zoom)}</strong>
                  <small>{periodSubtitle(p, view.zoom)}</small>
                </div>
              ))}
            </div>
          </div>

          {view.mode === 'people' &&
            (people.length === 0 ? (
              <p className="rm-empty">No people match. Add people on the People tab.</p>
            ) : (
              people.map((person) => (
                <PersonRow
                  key={person.id}
                  person={person}
                  all={byPersonAll.get(person.id) ?? []}
                  shown={byPersonShown.get(person.id) ?? []}
                  projectsById={projectsById}
                  geometry={geometry}
                  display={view.display}
                  collapsed={collapsed.has(person.id)}
                  today={today}
                  onToggle={() => toggle(person.id)}
                  onCreate={(day) => onNewAssignment({ person_id: person.id, starts_at: day, ends_at: day, project_id: view.project || undefined })}
                  onEdit={onEditAssignment}
                  onMove={saveMove}
                />
              ))
            ))}

          {view.mode === 'projects' &&
            (projects.length === 0 ? (
              <p className="rm-empty">No active projects match.</p>
            ) : (
              projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  assignments={assignments.filter((a) => a.project_id === project.id)}
                  peopleById={peopleById}
                  geometry={geometry}
                  today={today}
                  collapsed={collapsed.has(project.id)}
                  onToggle={() => toggle(project.id)}
                  onCreate={(day) => onNewAssignment({ project_id: project.id, starts_at: day, ends_at: day })}
                  onEdit={onEditAssignment}
                  onMove={saveMove}
                />
              ))
            ))}
        </div>
      </section>
    </div>
  )
}

function periodTitle(p: Period, zoom: Zoom): string {
  if (zoom === 'day') return shortDate(p.start)
  if (zoom === 'month') return new Date(`${p.start}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const end = p.start.slice(0, 7) === p.end.slice(0, 7) ? p.end.slice(8).replace(/^0/, '') : shortDate(p.end)
  return `${shortDate(p.start)} — ${end}${p.start.slice(0, 4) !== p.end.slice(0, 4) ? `, ${p.end.slice(0, 4)}` : ''}`
}

function periodSubtitle(p: Period, zoom: Zoom): string {
  if (zoom === 'day') return new Date(`${p.start}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
  if (zoom === 'week') return `Week ${isoWeek(p.start)}`
  return ''
}

interface Geometry {
  periods: Period[]
  width: number
  zoom: Zoom
}

type MoveFn = (before: Assignment, after: Assignment) => Promise<string | null>

/** Clicking the empty lane creates an assignment on the day clicked. */
function laneClick(g: Geometry, onCreate: (day: string) => void) {
  return (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    const rect = e.currentTarget.getBoundingClientRect()
    onCreate(dateAt(g.periods, g.width, e.clientX - rect.left))
  }
}

function PersonRow({
  person,
  all,
  shown,
  projectsById,
  geometry: g,
  display,
  collapsed,
  today,
  onToggle,
  onCreate,
  onEdit,
  onMove,
}: {
  person: Person
  all: Assignment[]
  shown: Assignment[]
  projectsById: ReadonlyMap<string, Project>
  geometry: Geometry
  display: Display
  collapsed: boolean
  today: string
  onToggle: () => void
  onCreate: (day: string) => void
  onEdit: (a: Assignment) => void
  onMove: MoveFn
}) {
  const start = g.periods[0].start
  const end = g.periods[g.periods.length - 1].end
  const sub = [person.role, person.discipline].filter((v) => v && v !== fullName(person)).join(', ')
  const visible = shown.filter((a) => a.ends_at >= start && a.starts_at <= end).sort((a, b) => a.starts_at.localeCompare(b.starts_at))

  return (
    <div className="rm-tl-group" role="rowgroup" aria-label={fullName(person)}>
      <div className="rm-tl-row" role="row">
        <div className="rm-tl-label" role="rowheader">
          <Avatar person={person} size={28} />
          <div>
            <strong>{fullName(person)}</strong>
            {sub && <div className="rm-muted rm-small">{sub}</div>}
          </div>
          <button type="button" className="rm-icon-button" aria-expanded={!collapsed} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${fullName(person)}`} onClick={onToggle}>
            {collapsed ? '▾' : '▴'}
          </button>
        </div>
        <div className="rm-tl-lane" style={{ width: g.periods.length * g.width }} onClick={laneClick(g, onCreate)} title="Click to assign">
          <TodayLine g={g} today={today} />
          {display === 'heatmap'
            ? g.periods.map((p, i) => {
                const avg = averageAllocation(all, p.start, p.end)
                return (
                  <div key={p.start} className={`rm-heat is-${heatLevel(avg)}`} style={{ left: i * g.width, width: g.width }} role="gridcell">
                    {formatPercent(avg)}
                  </div>
                )
              })
            : allocationSegments(all, start, end).map((s) => {
                const left = xOf(g.periods, g.width, s.start)
                const w = xOf(g.periods, g.width, s.end, true) - left
                const over = s.allocation > 100
                return (
                  <div
                    key={s.start}
                    role="gridcell"
                    className={`rm-avail${over ? ' is-over' : s.allocation >= 100 ? ' is-full' : s.allocation > 0 ? ' is-partial' : ''}`}
                    style={{ left, width: w }}
                  >
                    {w > 70 && (over ? <><b>Overallocated:</b> {Math.round(s.allocation - 100)}%</> : <><b>Available:</b> {Math.max(0, Math.round(100 - s.allocation))}%</>)}
                  </div>
                )
              })}
        </div>
      </div>
      {!collapsed && display === 'details' && visible.length > 0 && (
        <div className="rm-tl-row is-bars" role="row">
          <div className="rm-tl-label" role="rowheader">
            <span className="rm-muted rm-small">{visible.length} assignment{visible.length === 1 ? '' : 's'}</span>
          </div>
          <div className="rm-tl-lane rm-bars" style={{ width: g.periods.length * g.width, height: visible.length * 30 + 6 }}>
            <TodayLine g={g} today={today} />
            {visible.map((a, i) => (
              <Bar key={a.id} a={a} row={i} g={g} label={projectsById.get(a.project_id)?.name ?? 'Project'} type={projectsById.get(a.project_id)?.project_type} onEdit={onEdit} onMove={onMove} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ProjectRow({
  project,
  assignments,
  peopleById,
  geometry: g,
  today,
  collapsed,
  onToggle,
  onCreate,
  onEdit,
  onMove,
}: {
  project: Project
  assignments: Assignment[]
  peopleById: ReadonlyMap<string, Person>
  geometry: Geometry
  today: string
  collapsed: boolean
  onToggle: () => void
  onCreate: (day: string) => void
  onEdit: (a: Assignment) => void
  onMove: MoveFn
}) {
  const left = xOf(g.periods, g.width, project.starts_at)
  const w = Math.max(4, xOf(g.periods, g.width, project.ends_at, true) - left)
  const list = [...assignments].sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  return (
    <div className="rm-tl-group" role="rowgroup" aria-label={project.name}>
      <div className="rm-tl-row" role="row">
        <div className="rm-tl-label" role="rowheader">
          <span className={`rm-swatch is-${project.project_type}`} aria-hidden="true" />
          <div>
            <strong>{project.name}</strong>
            <div className="rm-muted rm-small">{project.client ?? PROJECT_TYPE_LABELS[project.project_type]}</div>
          </div>
          <button type="button" className="rm-icon-button" aria-expanded={!collapsed} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${project.name}`} onClick={onToggle}>
            {collapsed ? '▾' : '▴'}
          </button>
        </div>
        <div className="rm-tl-lane" style={{ width: g.periods.length * g.width }} onClick={laneClick(g, onCreate)} title="Click to assign">
          <TodayLine g={g} today={today} />
          <div className={`rm-project-span is-${project.project_type}`} style={{ left, width: w }} role="gridcell">
            {w > 80 && `${list.length} assigned`}
          </div>
        </div>
      </div>
      {!collapsed && list.length > 0 && (
        <div className="rm-tl-row is-bars" role="row">
          <div className="rm-tl-label" role="rowheader" />
          <div className="rm-tl-lane rm-bars" style={{ width: g.periods.length * g.width, height: list.length * 30 + 6 }}>
            <TodayLine g={g} today={today} />
            {list.map((a, i) => {
              const p = peopleById.get(a.person_id)
              return <Bar key={a.id} a={a} row={i} g={g} label={p ? fullName(p) : 'Person'} type={project.project_type} onEdit={onEdit} onMove={onMove} />
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function TodayLine({ g, today }: { g: Geometry; today: string }) {
  const s = g.periods[0].start
  const e = g.periods[g.periods.length - 1].end
  if (today < s || today > e) return null
  return <div className="rm-today-line" style={{ left: xOf(g.periods, g.width, today) }} aria-hidden="true" />
}

type DragKind = 'move' | 'start' | 'end'

/**
 * One assignment bar. Drag the body to move it, or an edge to change its start or end; a click
 * without movement opens it. Moves snap to whole days.
 */
function Bar({ a, row, g, label, type, onEdit, onMove }: { a: Assignment; row: number; g: Geometry; label: string; type?: string; onEdit: (a: Assignment) => void; onMove: MoveFn }) {
  const drag = useRef<{ kind: DragKind; x: number; moved: boolean } | null>(null)
  const [delta, setDelta] = useState<{ kind: DragKind; days: number } | null>(null)
  const perDay = pxPerDay(g.zoom)

  const preview = (kind: DragKind, days: number): Assignment => {
    if (kind === 'move') return { ...a, starts_at: addDays(a.starts_at, days), ends_at: addDays(a.ends_at, days) }
    if (kind === 'start') {
      const s = addDays(a.starts_at, days)
      return { ...a, starts_at: s > a.ends_at ? a.ends_at : s }
    }
    const e = addDays(a.ends_at, days)
    return { ...a, ends_at: e < a.starts_at ? a.starts_at : e }
  }
  const shown = delta ? preview(delta.kind, delta.days) : a
  const left = xOf(g.periods, g.width, shown.starts_at)
  const w = Math.max(6, xOf(g.periods, g.width, shown.ends_at, true) - left)

  function down(kind: DragKind) {
    return (e: ReactPointerEvent) => {
      e.stopPropagation()
      if (e.button !== 0) return
      drag.current = { kind, x: e.clientX, moved: false }
      ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    }
  }
  function move(e: ReactPointerEvent) {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    if (Math.abs(dx) > 3) d.moved = true
    if (d.moved) setDelta({ kind: d.kind, days: Math.round(dx / perDay) })
  }
  function up() {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (!d.moved) {
      setDelta(null)
      onEdit(a)
      return
    }
    const final = delta ? preview(delta.kind, delta.days) : a
    if (final.starts_at === a.starts_at && final.ends_at === a.ends_at) {
      setDelta(null)
      return
    }
    void onMove(a, final).finally(() => setDelta(null))
  }

  const text = `${label} · ${a.allocation_percent}%`
  return (
    <div
      className={`rm-bar is-${type ?? 'confirmed'}${a.status === 'tentative' ? ' is-tentative' : ''}${delta ? ' is-dragging' : ''}`}
      style={{ left, width: w, top: 4 + row * 30 }}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        drag.current = null
        setDelta(null)
      }}
    >
      <span className="rm-bar-handle is-start" onPointerDown={down('start')} aria-hidden="true" />
      <button
        type="button"
        className="rm-bar-body"
        onPointerDown={down('move')}
        onClick={(e) => {
          // Keyboard activation (pointer clicks are handled on pointer up).
          if (e.detail === 0) onEdit(a)
        }}
        title={`${text}\n${a.starts_at} → ${a.ends_at}${a.status === 'tentative' ? ' (tentative)' : ''}${a.notes ? `\n${a.notes}` : ''}`}
      >
        {text}
      </button>
      <span className="rm-bar-handle is-end" onPointerDown={down('end')} aria-hidden="true" />
    </div>
  )
}
