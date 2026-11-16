import { useMemo, useState } from 'react'
import { ConfirmDialog } from '../views/ConfirmDialog'
import { Icon } from '../ui/Icon'
import { utilizationOf, type Resource } from './engine'
import { KIND_LABEL, fmtHours, pct, todayIso, windowFor } from './format'
import { loadModel } from './resourceStore'
import { useResourceStore, useResourceStoreApi } from './ResourceStoreContext'
import { ResourceDialog } from './ResourceDialog'
import { matchesView } from './Workload'

const weekHours = (r: Resource) => r.hoursByWeekday.reduce((s, h) => s + h, 0)

/** The resource register: who can be assigned, their capacity and rate. Add, edit and remove here. */
export function ResourceList() {
  const store = useResourceStoreApi()
  const resources = useResourceStore((s) => s.resources)
  const assignments = useResourceStore((s) => s.assignments)
  const loaded = useResourceStore((s) => s.loaded)
  const model = useResourceStore(loadModel)
  const [editing, setEditing] = useState<Resource | 'new' | null>(null)
  const [removing, setRemoving] = useState<Resource | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const departments = useMemo(() => [...new Set(resources.map((r) => r.department).filter((d): d is string => !!d))].sort(), [resources])
  const next4 = useMemo(() => {
    const w = windowFor('week', todayIso(), 4)
    return { from: w.from, to: w.to }
  }, [])
  const shown = resources.filter((r) => matchesView(r, { department: '', kind: '', query }))
  const countOf = (id: string) => assignments.filter((a) => a.resourceId === id).length

  async function confirmRemove() {
    const r = removing
    setRemoving(null)
    if (!r) return
    const res = await store.getState().deleteResource(r.id)
    setError(res.ok ? null : res.error)
  }

  return (
    <section aria-label="Resources" className="res-section">
      <div className="res-toolbar">
        <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
          <Icon name="plus" size={16} />
          Add resource
        </button>
        <input type="search" aria-label="Search resources" placeholder="Search name, skill…" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
      </div>
      {error && (
        <p role="alert" className="res-alert">
          {error}
        </p>
      )}
      {!loaded ? (
        <div className="res-skeleton" aria-busy="true">
          <p className="visually-hidden">Loading resources…</p>
          {[0, 1, 2].map((i) => (
            <span key={i} className="skeleton" style={{ width: `${96 - i * 8}%` }} />
          ))}
        </div>
      ) : resources.length === 0 ? (
        <div className="res-empty">
          <h3>No resources yet</h3>
          <p>A resource is a person, a role (such as an electrical engineer) or a piece of equipment. Give it a weekly capacity and a rate, then assign it to tasks.</p>
          <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
            Add your first resource
          </button>
        </div>
      ) : (
        <ul className="res-cards" aria-label="Resource list">
          {shown.map((r) => {
            const u = utilizationOf(model, r.id, next4.from, next4.to)
            return (
              <li key={r.id} className="res-card card">
                <div className="res-card-main">
                  <h3>{r.name}</h3>
                  <p>
                    <span className="chip">{KIND_LABEL[r.kind]}</span>
                    {r.department && <span className="res-dept">{r.department}</span>}
                  </p>
                  {r.skills.length > 0 && (
                    <p className="res-skills" aria-label="Skills">
                      {r.skills.map((s) => (
                        <span key={s}>{s}</span>
                      ))}
                    </p>
                  )}
                </div>
                <dl className="res-card-facts">
                  <div>
                    <dt>Capacity</dt>
                    <dd>{fmtHours(weekHours(r))} h/week</dd>
                  </div>
                  <div>
                    <dt>Rate</dt>
                    <dd>{r.costRate > 0 ? `${r.costRate.toLocaleString('en-GB', { maximumFractionDigits: 2 })}/h` : '–'}</dd>
                  </div>
                  <div>
                    <dt>Next 4 weeks</dt>
                    <dd className={u.overDays > 0 ? 'is-over' : undefined}>
                      {pct(u.utilization)}
                      {u.overDays > 0 ? ` · ${u.overDays} over` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Assigned to</dt>
                    <dd>
                      {countOf(r.id)} {countOf(r.id) === 1 ? 'task' : 'tasks'}
                    </dd>
                  </div>
                  {r.timeOff.length > 0 && (
                    <div>
                      <dt>Time off</dt>
                      <dd>{r.timeOff.length}</dd>
                    </div>
                  )}
                </dl>
                <div className="res-card-actions">
                  <button type="button" className="btn-sm" onClick={() => setEditing(r)}>
                    <Icon name="pencil" size={14} />
                    Edit
                    <span className="visually-hidden"> {r.name}</span>
                  </button>
                  <button type="button" className="btn-icon is-danger" aria-label={`Remove ${r.name}`} title="Remove" onClick={() => setRemoving(r)}>
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {editing && <ResourceDialog resource={editing === 'new' ? null : editing} departments={departments} onClose={() => setEditing(null)} />}
      {removing && (
        <ConfirmDialog
          title="Remove resource"
          message={`Remove ${removing.name}? Their ${countOf(removing.id)} assignment${countOf(removing.id) === 1 ? '' : 's'} and time off are removed too. This cannot be undone.`}
          confirmLabel="Remove"
          onConfirm={() => void confirmRemove()}
          onCancel={() => setRemoving(null)}
        />
      )}
    </section>
  )
}
