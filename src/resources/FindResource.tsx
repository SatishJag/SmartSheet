import { useMemo, useState } from 'react'
import { findAvailable, type ResourceKind } from './engine'
import { Field } from './Field'
import { KIND_LABEL, fmtHours, fmtShort, shiftAnchor, todayIso } from './format'
import { loadModel } from './resourceStore'
import { useResourceStore } from './ResourceStoreContext'

type Need = 'any' | 'hours_per_day' | 'percent' | 'total_hours'

/** Who is free for these dates, best fit first. */
export function FindResource({ onShowWorkload }: { onShowWorkload(resourceName: string, from: string): void }) {
  const model = useResourceStore(loadModel)
  const resources = useResourceStore((s) => s.resources)
  const loaded = useResourceStore((s) => s.loaded)
  const [from, setFrom] = useState(() => todayIso())
  const [to, setTo] = useState(() => shiftAnchor('week', todayIso(), 2))
  const [need, setNeed] = useState<Need>('hours_per_day')
  const [amount, setAmount] = useState('4')
  const [department, setDepartment] = useState('')
  const [kind, setKind] = useState<'' | ResourceKind>('')
  const [skills, setSkills] = useState('')

  const departments = useMemo(() => [...new Set(resources.map((r) => r.department).filter((d): d is string => !!d))].sort(), [resources])
  const value = Number(amount)
  const valid = from !== '' && to !== '' && to >= from && (need === 'any' || (Number.isFinite(value) && value > 0))
  const results = useMemo(() => {
    if (!valid) return []
    return findAvailable(model, {
      from,
      to,
      ...(need === 'hours_per_day' ? { hoursPerDay: value } : need === 'percent' ? { percent: value } : need === 'total_hours' ? { totalHours: value } : {}),
      department: department || undefined,
      kind: kind || undefined,
      skills: skills.split(',').map((s) => s.trim()).filter(Boolean),
    })
  }, [model, valid, from, to, need, value, department, kind, skills])
  const byId = new Map(resources.map((r) => [r.id, r]))
  const fitting = results.filter((r) => r.fits).length

  return (
    <section aria-label="Find a resource" className="res-section">
      <form className="res-find" onSubmit={(e) => e.preventDefault()}>
        <Field label="From">{(id) => <input id={id} type="date" value={from} onChange={(e) => setFrom(e.currentTarget.value)} />}</Field>
        <Field label="To">{(id) => <input id={id} type="date" value={to} min={from} onChange={(e) => setTo(e.currentTarget.value)} />}</Field>
        <Field label="I need">
          {(id) => (
            <select id={id} value={need} onChange={(e) => setNeed(e.currentTarget.value as Need)}>
              <option value="hours_per_day">Free hours per day</option>
              <option value="percent">% of capacity per day</option>
              <option value="total_hours">Free hours in total</option>
              <option value="any">Anyone with free time</option>
            </select>
          )}
        </Field>
        {need !== 'any' && (
          <Field label={need === 'percent' ? 'Percent' : 'Hours'}>
            {(id) => <input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.currentTarget.value)} aria-invalid={!valid} />}
          </Field>
        )}
        <Field label="Department">
          {(id) => (
            <select id={id} value={department} onChange={(e) => setDepartment(e.currentTarget.value)}>
              <option value="">Any</option>
              {departments.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Type">
          {(id) => (
            <select id={id} value={kind} onChange={(e) => setKind(e.currentTarget.value as '' | ResourceKind)}>
              <option value="">Any</option>
              {(['person', 'role', 'equipment'] as const).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Skills" className="res-find-skills">
          {(id) => <input id={id} value={skills} placeholder="Comma separated" onChange={(e) => setSkills(e.currentTarget.value)} />}
        </Field>
      </form>

      {!loaded ? (
        <p className="res-hint" role="status">Loading…</p>
      ) : !valid ? (
        <p role="alert" className="res-alert">
          Enter a start date, an end date on or after it, and a positive amount.
        </p>
      ) : results.length === 0 ? (
        <div className="res-empty">
          <h3>No resource matches</h3>
          <p>Try fewer skills or another department.</p>
        </div>
      ) : (
        <>
          <p className="res-hint" role="status">
            {fitting === 0 ? 'Nobody fits the whole period. Closest first.' : `${fitting} ${fitting === 1 ? 'resource fits' : 'resources fit'} ${fmtShort(from)} to ${fmtShort(to)}.`}
          </p>
          <ul className="res-found" aria-label="Results">
            {results.map((a) => {
              const r = byId.get(a.resourceId)!
              const u = a.availableHours > 0 ? a.assignedHours / a.availableHours : null
              return (
                <li key={a.resourceId} className={`card res-found-row${a.fits ? ' fits' : ''}`}>
                  <div className="res-found-name">
                    <strong>{r.name}</strong>
                    <small>{[KIND_LABEL[r.kind], r.department, r.skills.join(', ')].filter(Boolean).join(' · ')}</small>
                  </div>
                  <span className={`badge-fit${a.fits ? ' is-fit' : ''}`}>{a.fits ? 'Fits' : a.workingDays === 0 ? 'Away' : 'Does not fit'}</span>
                  <div className="res-found-bar" role="img" aria-label={`${fmtHours(a.assignedHours)} of ${fmtHours(a.availableHours)} hours already assigned`}>
                    <span style={{ width: `${Math.min(100, (u ?? 0) * 100)}%` }} data-over={u !== null && u > 1 ? '' : undefined} />
                  </div>
                  <dl>
                    <div>
                      <dt>Free</dt>
                      <dd>{fmtHours(a.freeHours)} h</dd>
                    </div>
                    <div>
                      <dt>Least free day</dt>
                      <dd>{fmtHours(a.minFreePerDay)} h</dd>
                    </div>
                  </dl>
                  <button type="button" className="btn-sm" onClick={() => onShowWorkload(r.name, from)}>
                    Show workload
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}
