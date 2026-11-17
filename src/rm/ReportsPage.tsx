import { useMemo, useState } from 'react'
import type { RmData } from './api'
import { addDays, endOfWeek, startOfWeek, usDate, workingDays } from './dates'
import { assignmentDays, availability, byPerson, formatDays, formatMoney, formatPercent, projectTracking, type ProjectTracking } from './metrics'
import { fullName, type Assignment, type Person, type Project } from './types'

export function ReportsPage({ data, today, title }: { data: RmData; today: string; title: string }) {
  const peopleById = useMemo(() => new Map(data.people.map((p) => [p.id, p])), [data.people])
  const assignmentsByPerson = useMemo(() => byPerson(data.assignments), [data.assignments])
  const active = data.projects.filter((p) => p.state === 'active')
  const tracked = (type: 'amount' | 'days') =>
    active
      .filter((p) => p.budget_type === type)
      .map((p) => ({ project: p, t: projectTracking(p, data.assignments, peopleById, today) }))
      .sort((a, b) => a.project.name.localeCompare(b.project.name))

  const thisWeek: [string, string] = [today, endOfWeek(today)]
  const nextStart = addDays(startOfWeek(today), 7)
  const nextWeek: [string, string] = [nextStart, endOfWeek(nextStart)]
  const people = [...data.people].sort((a, b) => fullName(a).localeCompare(fullName(b)))

  return (
    <div className="rm-reports">
      <h1>{title}</h1>
      <div className="rm-reports-grid">
        <section aria-labelledby="rm-who">
          <h2 id="rm-who">Who&apos;s available?</h2>
          <Availability label="This week, remaining" range={thisWeek} people={people} byPersonMap={assignmentsByPerson} />
          <Availability label="Next week" range={nextWeek} people={people} byPersonMap={assignmentsByPerson} />
        </section>
        <div className="rm-reports-main">
          <BudgetSection title="Active Projects Tracked in Currency" unit="amount" rows={tracked('amount')} />
          <BudgetSection title="Active Projects Tracked in Days" unit="days" rows={tracked('days')} />
          <SavedReports data={data} today={today} peopleById={peopleById} />
        </div>
      </div>
    </div>
  )
}

function Availability({
  label,
  range,
  people,
  byPersonMap,
}: {
  label: string
  range: [string, string]
  people: Person[]
  byPersonMap: ReadonlyMap<string, Assignment[]>
}) {
  const noWorkLeft = workingDays(range[0], range[1]) === 0
  return (
    <div className="rm-avail-block">
      <h3>{label}</h3>
      {people.length === 0 ? (
        <p className="rm-muted rm-small">No people yet.</p>
      ) : noWorkLeft ? (
        <p className="rm-muted rm-small">No working days left.</p>
      ) : (
        <ul className="rm-tiles">
          {people.map((p) => {
            const free = availability(byPersonMap.get(p.id) ?? [], range[0], range[1]) ?? 0
            const level = free >= 75 ? 'high' : free >= 25 ? 'mid' : free > 0 ? 'low' : 'none'
            return (
              <li key={p.id} className={`rm-tile is-${level}`} title={`${fullName(p)}: ${formatPercent(free)} available`}>
                <span>{fullName(p)}</span>
                <small>{formatPercent(free)}</small>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function BudgetSection({
  title,
  unit,
  rows,
}: {
  title: string
  unit: 'amount' | 'days'
  rows: { project: Project; t: ProjectTracking }[]
}) {
  const fmt = unit === 'amount' ? formatMoney : (n: number) => `${formatDays(n)} days`
  const incurred = (t: ProjectTracking) => (unit === 'amount' ? t.incurredAmount : t.incurredDays)
  const future = (t: ProjectTracking) => (unit === 'amount' ? t.futureAmount : t.futureDays)
  const scale = Math.max(1, ...rows.map((r) => Math.max(r.t.budget ?? 0, r.t.forecast)))
  const pct = (n: number) => `${(n / scale) * 100}%`

  return (
    <section className="rm-budget" aria-label={title}>
      <div className="rm-budget-head">
        <h2>{title}</h2>
        <h2>Forecasted Budget</h2>
      </div>
      <div className="rm-legend rm-small">
        <span>
          <i className="rm-key is-budget" /> Project Budget{unit === 'days' ? ' (days)' : ''}
        </span>
        <span>
          <i className="rm-key is-incurred" /> Incurred{unit === 'days' ? ' Days' : ''}
        </span>
        <span>
          <i className="rm-key is-future" /> Future Scheduled{unit === 'days' ? ' Days' : ''}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="rm-muted rm-small">
          No active projects track their budget in {unit === 'amount' ? 'currency' : 'days'}. Set budget tracking when editing a project.
        </p>
      ) : (
        <ul className="rm-budget-rows">
          {rows.map(({ project, t }) => {
            const over = (t.remaining ?? 0) < 0
            const inc = incurred(t)
            const fut = future(t)
            return (
              <li key={project.id} className="rm-budget-row">
                <div className="rm-budget-name">
                  {project.client && <small>{project.client}</small>}
                  <strong title={project.name}>{project.name}</strong>
                </div>
                <div
                  className="rm-budget-bar"
                  role="img"
                  aria-label={`${project.name}: budget ${fmt(t.budget ?? 0)}, incurred ${fmt(inc)}, future scheduled ${fmt(fut)}`}
                >
                  <div className="rm-bar-incurred" style={{ width: pct(inc) }} />
                  <div className="rm-bar-future" style={{ left: pct(inc), width: pct(fut) }} />
                  {over && <div className="rm-bar-over" style={{ left: pct(t.budget ?? 0), width: pct(-(t.remaining ?? 0)) }} />}
                  <div className="rm-bar-budget" style={{ width: pct(t.budget ?? 0) }} />
                </div>
                <div className={`rm-forecast${over ? ' is-over' : ''}`}>
                  <span className="rm-forecast-icon" aria-hidden="true" />
                  <span>
                    {over ? `${fmt(-(t.remaining ?? 0))} over budget` : `${fmt(t.remaining ?? 0)} remaining`}
                    <br />
                    <small>or {formatPercent(Math.abs((t.remainingRatio ?? 0) * 100))}</small>
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------------- Saved reports

interface Report {
  id: string
  name: string
  columns: string[]
  rows(): (string | number)[][]
}

function buildReports(data: RmData, today: string, peopleById: ReadonlyMap<string, Person>): Report[] {
  const projectsById = new Map(data.projects.map((p) => [p.id, p]))
  const horizonEnd = addDays(today, 27)
  return [
    {
      id: 'forecast',
      name: 'What are the forecasted budgets of my active projects?',
      columns: ['Project', 'Client', 'Tracking', 'Budget', 'Incurred', 'Future scheduled', 'Forecast', 'Remaining'],
      rows: () =>
        data.projects
          .filter((p) => p.state === 'active')
          .map((p) => {
            const t = projectTracking(p, data.assignments, peopleById, today)
            const days = p.budget_type === 'days'
            const r = (n: number) => (days ? Math.round(n * 10) / 10 : Math.round(n))
            return [
              p.name,
              p.client ?? '',
              p.budget_type === 'none' ? 'Not tracked' : days ? 'Days' : 'Currency',
              t.budget === null ? '' : r(t.budget),
              r(days ? t.incurredDays : t.incurredAmount),
              r(days ? t.futureDays : t.futureAmount),
              r(t.forecast),
              t.remaining === null ? '' : r(t.remaining),
            ]
          }),
    },
    {
      id: 'tentative',
      name: 'Who has unconfirmed (tentative) time scheduled?',
      columns: ['Person', 'Project', 'Starts', 'Ends', 'Allocation %', 'Person-days'],
      rows: () =>
        data.assignments
          .filter((a) => a.status === 'tentative' || projectsById.get(a.project_id)?.project_type === 'tentative')
          .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
          .map((a) => {
            const person = peopleById.get(a.person_id)
            return [person ? fullName(person) : '', projectsById.get(a.project_id)?.name ?? '', usDate(a.starts_at), usDate(a.ends_at), a.allocation_percent, Math.round(assignmentDays(a) * 10) / 10]
          }),
    },
    {
      id: 'utilization',
      name: 'What is the utilization of each person over the next 4 weeks?',
      columns: ['Person', 'Role', 'Capacity hours', 'Scheduled hours', 'Utilization %'],
      rows: () => {
        const map = byPerson(data.assignments)
        const days = workingDays(today, horizonEnd)
        return [...data.people]
          .sort((a, b) => fullName(a).localeCompare(fullName(b)))
          .map((p) => {
            const capacity = days * p.capacity_hours_per_day
            const scheduled = (map.get(p.id) ?? []).reduce((s, a) => s + assignmentDays(a, today, horizonEnd), 0) * p.capacity_hours_per_day
            return [fullName(p), p.role ?? '', Math.round(capacity), Math.round(scheduled), capacity ? Math.round((scheduled / capacity) * 100) : 0]
          })
      },
    },
    {
      id: 'progress',
      name: 'What is the progress of each active project?',
      columns: ['Project', 'Starts', 'Ends', 'Elapsed %', 'People assigned', 'Days incurred', 'Days scheduled'],
      rows: () =>
        data.projects
          .filter((p) => p.state === 'active')
          .map((p) => {
            const total = workingDays(p.starts_at, p.ends_at)
            const done = workingDays(p.starts_at, addDays(today < p.ends_at ? today : addDays(p.ends_at, 1), -1))
            const t = projectTracking(p, data.assignments, peopleById, today)
            const people = new Set(data.assignments.filter((a) => a.project_id === p.id).map((a) => a.person_id))
            return [
              p.name,
              usDate(p.starts_at),
              usDate(p.ends_at),
              total ? Math.round((Math.max(0, done) / total) * 100) : 0,
              people.size,
              Math.round(t.incurredDays * 10) / 10,
              Math.round((t.incurredDays + t.futureDays) * 10) / 10,
            ]
          }),
    },
  ]
}

export function toCsv(columns: string[], rows: (string | number)[][]): string {
  const cell = (v: string | number) => {
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [columns, ...rows].map((r) => r.map(cell).join(',')).join('\n')
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function SavedReports({ data, today, peopleById }: { data: RmData; today: string; peopleById: ReadonlyMap<string, Person> }) {
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const reports = buildReports(data, today, peopleById)
  const shown = reports.filter((r) => r.name.toLowerCase().includes(query.trim().toLowerCase()))
  const open = reports.find((r) => r.id === openId)
  const rows = open?.rows() ?? []

  return (
    <section className="rm-saved-reports" aria-labelledby="rm-saved">
      <h2 id="rm-saved">Saved Reports</h2>
      <input type="search" aria-label="Search reports" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
      <table className="rm-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Refresh type</th>
            <th>Refresh status</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id}>
              <td>
                <button type="button" className="rm-row-link" aria-expanded={openId === r.id} onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                  {r.name}
                </button>
              </td>
              <td>Live</td>
              <td>Up to date</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && (
        <div className="rm-report" aria-label={open.name} role="region">
          <div className="rm-content-head">
            <h3>{open.name}</h3>
            <button type="button" onClick={() => download(open.name, toCsv(open.columns, rows))}>
              Export CSV
            </button>
          </div>
          {rows.length === 0 ? (
            <p className="rm-muted">Nothing to report yet.</p>
          ) : (
            <table className="rm-table">
              <thead>
                <tr>
                  {open.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j}>{v}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  )
}
