import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { DEFAULT_HOURS_BY_WEEKDAY, type Resource, type ResourceKind, type TimeOff } from './engine'
import { KIND_LABEL, fmtHours } from './format'
import { useResourceStoreApi } from './ResourceStoreContext'
import '../views/confirmDialog.css'

/** Listed Monday first; values are JS weekdays (0 = Sunday), the order the capacity array uses. */
const WEEKDAYS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
]

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'

interface TimeOffDraft extends Omit<TimeOff, 'hours'> {
  key: string
  hours: string
}

/** Validates a resource form; returns the first problem or the resource. */
export function validateResource(input: {
  id: string
  name: string
  kind: ResourceKind
  department: string
  skills: string
  costRate: string
  hours: string[]
  timeOff: { start: string; end: string; hours: string; note?: string }[]
}): { ok: true; resource: Resource } | { ok: false; error: string } {
  const name = input.name.trim()
  if (name.length === 0) return { ok: false, error: 'Enter a name' }
  if (name.length > 100) return { ok: false, error: 'The name can be at most 100 characters' }
  if (input.department.trim().length > 100) return { ok: false, error: 'The department can be at most 100 characters' }
  const rate = input.costRate.trim() === '' ? 0 : Number(input.costRate)
  if (!Number.isFinite(rate) || rate < 0 || rate > 1_000_000) return { ok: false, error: 'The cost rate must be a number from 0 to 1,000,000' }
  const hours = input.hours.map((h) => (h.trim() === '' ? 0 : Number(h)))
  if (hours.length !== 7 || hours.some((h) => !Number.isFinite(h) || h < 0 || h > 24)) return { ok: false, error: 'Capacity must be 0 to 24 hours for every day' }
  const skills = [...new Set(input.skills.split(',').map((s) => s.trim()).filter(Boolean))]
  if (skills.length > 30) return { ok: false, error: 'At most 30 skills' }
  if (skills.some((s) => s.length > 40)) return { ok: false, error: 'A skill can be at most 40 characters' }
  const timeOff: TimeOff[] = []
  for (const t of input.timeOff) {
    if (!t.start || !t.end) return { ok: false, error: 'Time off needs a start and an end date' }
    if (t.end < t.start) return { ok: false, error: 'Time off cannot end before it starts' }
    if ((Date.parse(t.end) - Date.parse(t.start)) / 86_400_000 > 3660) return { ok: false, error: 'A time-off period can be at most 10 years' }
    const h = t.hours.trim() === '' ? 0 : Number(t.hours)
    if (!Number.isFinite(h) || h < 0 || h > 24) return { ok: false, error: 'Time-off hours must be 0 to 24' }
    if ((t.note ?? '').length > 200) return { ok: false, error: 'A time-off note can be at most 200 characters' }
    timeOff.push({ start: t.start, end: t.end, hours: h, ...(t.note?.trim() ? { note: t.note.trim() } : {}) })
  }
  return {
    ok: true,
    resource: {
      id: input.id,
      name,
      kind: input.kind,
      department: input.department.trim() || null,
      skills,
      costRate: rate,
      hoursByWeekday: hours,
      timeOff,
    },
  }
}

/** Add or edit a resource: who, what kind, rate, weekly capacity and time off. */
export function ResourceDialog({ resource, departments, onClose }: { resource: Resource | null; departments: string[]; onClose: () => void }) {
  const store = useResourceStoreApi()
  const titleId = useId()
  const errId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [id] = useState(() => resource?.id ?? crypto.randomUUID())
  const [name, setName] = useState(resource?.name ?? '')
  const [kind, setKind] = useState<ResourceKind>(resource?.kind ?? 'person')
  const [department, setDepartment] = useState(resource?.department ?? '')
  const [skills, setSkills] = useState((resource?.skills ?? []).join(', '))
  const [costRate, setCostRate] = useState(resource ? String(resource.costRate) : '')
  const [hours, setHours] = useState<string[]>(() => (resource?.hoursByWeekday ?? DEFAULT_HOURS_BY_WEEKDAY).map(String))
  const [timeOff, setTimeOff] = useState<TimeOffDraft[]>(() => (resource?.timeOff ?? []).map((t) => ({ ...t, key: crypto.randomUUID(), hours: String(t.hours) })))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const weekTotal = hours.reduce((s, h) => s + (Number(h) || 0), 0)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const v = validateResource({ id, name, kind, department, skills, costRate, hours, timeOff })
    if (!v.ok) {
      setError(v.error)
      return
    }
    setSaving(true)
    const r = await store.getState().saveResource(v.resource)
    setSaving(false)
    if (r.ok) onClose()
    else setError(r.error)
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Tab' && dialogRef.current) {
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  const patchOff = (key: string, patch: Partial<TimeOffDraft>) => setTimeOff((list) => list.map((t) => (t.key === key ? { ...t, ...patch } : t)))

  return (
    <div className="confirm-backdrop">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="confirm-dialog res-dialog" onKeyDown={onKeyDown}>
        <h2 id={titleId}>{resource ? 'Edit resource' : 'Add resource'}</h2>
        <form onSubmit={submit} noValidate aria-describedby={error ? errId : undefined}>
          <div className="res-field">
            <label className="label" htmlFor={`${id}-name`}>Name</label>
            <input id={`${id}-name`} autoFocus value={name} maxLength={100} onChange={(e) => setName(e.currentTarget.value)} placeholder="e.g. Ada Okafor, Electrical engineer, Tower crane" />
          </div>

          <fieldset className="res-field">
            <legend className="label">Type</legend>
            <div role="group" aria-label="Type" className="segmented segmented-sm">
              {(['person', 'role', 'equipment'] as const).map((k) => (
                <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="res-row2">
            <div className="res-field">
              <label className="label" htmlFor={`${id}-dept`}>Department</label>
              <input id={`${id}-dept`} list={`${id}-depts`} value={department} maxLength={100} onChange={(e) => setDepartment(e.currentTarget.value)} placeholder="Optional" />
              <datalist id={`${id}-depts`}>
                {departments.map((d) => (
                  <option key={d} value={d} />
                ))}
              </datalist>
            </div>
            <div className="res-field">
              <label className="label" htmlFor={`${id}-rate`}>Cost rate per hour</label>
              <input id={`${id}-rate`} inputMode="decimal" value={costRate} onChange={(e) => setCostRate(e.currentTarget.value)} placeholder="0" />
            </div>
          </div>

          <div className="res-field">
            <label className="label" htmlFor={`${id}-skills`}>Skills</label>
            <input id={`${id}-skills`} value={skills} onChange={(e) => setSkills(e.currentTarget.value)} placeholder="Comma separated, e.g. Wiring, Testing" />
          </div>

          <fieldset className="res-field">
            <legend className="label">Capacity (hours per day)</legend>
            <div className="res-week">
              {WEEKDAYS.map((d) => (
                <label key={d.value}>
                  <span>{d.label}</span>
                  <input
                    inputMode="decimal"
                    aria-label={`${d.label} hours`}
                    value={hours[d.value]}
                    onChange={(e) => setHours((h) => h.map((x, i) => (i === d.value ? e.currentTarget.value : x)))}
                  />
                </label>
              ))}
            </div>
            <p className="res-hint">{fmtHours(weekTotal)} hours a week</p>
          </fieldset>

          <fieldset className="res-field">
            <legend className="label">Time off and exceptions</legend>
            <p className="res-hint">Hours per day on those dates. 0 means away; use a number to give a part day or a Saturday shift.</p>
            {timeOff.map((t) => (
              <div key={t.key} className="res-off">
                <input type="date" aria-label="From" value={t.start} onChange={(e) => patchOff(t.key, { start: e.currentTarget.value, end: t.end && t.end >= e.currentTarget.value ? t.end : e.currentTarget.value })} />
                <input type="date" aria-label="To" value={t.end} min={t.start} onChange={(e) => patchOff(t.key, { end: e.currentTarget.value })} />
                <input inputMode="decimal" aria-label="Hours per day" className="res-off-hours" value={t.hours} onChange={(e) => patchOff(t.key, { hours: e.currentTarget.value })} />
                <input aria-label="Note" placeholder="Note" maxLength={200} value={t.note ?? ''} onChange={(e) => patchOff(t.key, { note: e.currentTarget.value })} />
                <button type="button" className="btn-icon is-danger" aria-label="Remove time off" onClick={() => setTimeOff((l) => l.filter((x) => x.key !== t.key))}>
                  <span aria-hidden="true" className="res-x">×</span>
                </button>
              </div>
            ))}
            <button type="button" className="btn-sm" onClick={() => setTimeOff((l) => [...l, { key: crypto.randomUUID(), start: '', end: '', hours: '0' }])}>
              Add time off
            </button>
          </fieldset>

          {error && (
            <p id={errId} role="alert" className="res-alert">
              {error}
            </p>
          )}
          <div className="confirm-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
