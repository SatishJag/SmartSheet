import type { RmData } from './api'
import { endOfWeek, usDate } from './dates'
import { assignmentDays, availability, formatDays, formatPercent } from './metrics'
import { fullName, type Assignment, type Person } from './types'

export function MyWorkPage({
  data,
  email,
  today,
  onAddMe,
  onEditAssignment,
}: {
  data: RmData
  email: string
  today: string
  onAddMe: () => void
  onEditAssignment: (a: Assignment) => void
}) {
  const me: Person | undefined = data.people.find((p) => p.email && p.email.toLowerCase() === email.toLowerCase())
  if (!me) {
    return (
      <div className="rm-content rm-narrow">
        <h1>My Work</h1>
        <p>
          You are not in the people list yet. Add yourself with the email <strong>{email}</strong> to see the work scheduled
          for you here.
        </p>
        <button type="button" className="rm-primary" onClick={onAddMe}>
          Add me to People
        </button>
      </div>
    )
  }
  const projects = new Map(data.projects.map((p) => [p.id, p]))
  const mine = data.assignments.filter((a) => a.person_id === me.id).sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  const current = mine.filter((a) => a.starts_at <= today && today <= a.ends_at)
  const upcoming = mine.filter((a) => a.starts_at > today)
  const past = mine.filter((a) => a.ends_at < today)
  const free = availability(mine, today, endOfWeek(today))

  const list = (title: string, items: Assignment[]) => (
    <section aria-label={title}>
      <h2>
        {title} <span className="rm-muted">({items.length})</span>
      </h2>
      {items.length === 0 ? (
        <p className="rm-muted">Nothing here.</p>
      ) : (
        <table className="rm-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Dates</th>
              <th>Allocation</th>
              <th>Person-days</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td>
                  <button type="button" className="rm-row-link" onClick={() => onEditAssignment(a)}>
                    {projects.get(a.project_id)?.name ?? 'Project'}
                  </button>
                </td>
                <td>
                  {usDate(a.starts_at)} – {usDate(a.ends_at)}
                </td>
                <td>{a.allocation_percent}%</td>
                <td>{formatDays(assignmentDays(a))}</td>
                <td>{a.status === 'tentative' ? 'Tentative' : 'Confirmed'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )

  return (
    <div className="rm-content rm-narrow">
      <h1>My Work</h1>
      <p className="rm-muted">
        {fullName(me)} · Available for the rest of this week: <strong>{formatPercent(free)}</strong>
      </p>
      {list('Current', current)}
      {list('Upcoming', upcoming)}
      {list('Past', past)}
    </div>
  )
}
