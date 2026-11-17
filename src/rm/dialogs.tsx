import { useState } from 'react'
import { usDate } from './dates'
import { parseTags } from './filters'
import { Field, Modal } from './Modal'
import {
  blankPerson,
  fullName,
  MEMBER_TYPE_LABELS,
  OFFICE_STATUS_LABELS,
  PROJECT_TYPE_LABELS,
  type Assignment,
  type AssignmentInput,
  type BudgetType,
  type MemberType,
  type OfficeStatus,
  type Person,
  type PersonInput,
  type Project,
  type ProjectInput,
  type ProjectType,
} from './types'

const ISO = /^\d{4}-\d{2}-\d{2}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const orNull = (s: string) => (s.trim() === '' ? null : s.trim())

type Save<T> = (input: T) => Promise<string | null>

function useSubmit<T>(save: Save<T>, onDone: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(input: T | string) {
    if (typeof input === 'string') {
      setError(input)
      return
    }
    setBusy(true)
    setError(null)
    const err = await save(input)
    setBusy(false)
    if (err) setError(err)
    else onDone()
  }
  return { busy, error, submit }
}

// ---------------------------------------------------------------------------------- Person

export function PersonDialog({
  person,
  initialValues,
  onSave,
  onDelete,
  onClose,
}: {
  person: Person | null
  initialValues?: Partial<Person>
  onSave: Save<PersonInput>
  onDelete?: () => void
  onClose: () => void
}) {
  const start = person ?? { ...blankPerson(), id: '', ...initialValues }
  const [f, setF] = useState({
    first: start.first_name,
    last: start.last_name,
    email: start.email ?? '',
    role: start.role ?? '',
    discipline: start.discipline ?? '',
    location: start.location ?? '',
    tags: start.tags.join(', '),
    capacity: String(start.capacity_hours_per_day),
    rate: String(start.bill_rate),
    office: start.office_status ?? '',
    type: start.member_type,
    approver: start.is_approver,
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
  const { busy, error, submit } = useSubmit(onSave, onClose)

  function build(): PersonInput | string {
    if (!f.first.trim()) return 'First name is required'
    if (f.email.trim() && !EMAIL.test(f.email.trim())) return 'Enter a valid email address'
    const capacity = Number(f.capacity)
    if (!(capacity > 0 && capacity <= 24)) return 'Hours per day must be between 0 and 24'
    const rate = Number(f.rate || 0)
    if (!(rate >= 0)) return 'Bill rate must be 0 or more'
    return {
      first_name: f.first.trim(),
      last_name: f.last.trim(),
      email: orNull(f.email)?.toLowerCase() ?? null,
      role: orNull(f.role),
      discipline: orNull(f.discipline),
      location: orNull(f.location),
      tags: parseTags(f.tags),
      capacity_hours_per_day: capacity,
      bill_rate: rate,
      office_status: (f.office || null) as OfficeStatus | null,
      member_type: f.type,
      is_approver: f.approver,
    }
  }

  return (
    <Modal
      title={person ? `Edit ${fullName(person)}` : 'Add person'}
      submitLabel={person ? 'Save' : 'Add person'}
      onClose={onClose}
      onSubmit={() => void submit(build())}
      busy={busy}
      error={error}
      extraActions={
        onDelete && (
          <button type="button" className="rm-danger-link" onClick={onDelete}>
            Delete person
          </button>
        )
      }
    >
      <div className="rm-grid-2">
        <Field label="First name">
          <input value={f.first} onChange={set('first')} required />
        </Field>
        <Field label="Last name">
          <input value={f.last} onChange={set('last')} />
        </Field>
        <Field label="Email" hint="Links this person to a sign-in for My Work">
          <input type="email" value={f.email} onChange={set('email')} />
        </Field>
        <Field label="Team member type">
          <select value={f.type} onChange={(e) => setF((x) => ({ ...x, type: e.target.value as MemberType }))}>
            {Object.entries(MEMBER_TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Role">
          <input value={f.role} onChange={set('role')} placeholder="e.g. Project Manager" />
        </Field>
        <Field label="Discipline">
          <input value={f.discipline} onChange={set('discipline')} placeholder="e.g. Electrical" />
        </Field>
        <Field label="Location">
          <input value={f.location} onChange={set('location')} />
        </Field>
        <Field label="Office status">
          <select value={f.office} onChange={set('office')}>
            <option value="">--</option>
            {Object.entries(OFFICE_STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Hours per day">
          <input type="number" min="0.5" max="24" step="0.5" value={f.capacity} onChange={set('capacity')} />
        </Field>
        <Field label="Bill rate (per hour)">
          <input type="number" min="0" step="1" value={f.rate} onChange={set('rate')} />
        </Field>
        <Field label="Tags" hint="Comma-separated">
          <input value={f.tags} onChange={set('tags')} />
        </Field>
        <label className="rm-check">
          <input type="checkbox" checked={f.approver} onChange={(e) => setF((x) => ({ ...x, approver: e.target.checked }))} />
          Approver
        </label>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------- Project

export function ProjectDialog({
  project,
  initial,
  people,
  sheets,
  onSave,
  onDelete,
  onClose,
}: {
  project: Project | null
  initial: ProjectInput
  people: Person[]
  sheets: { id: string; name: string }[]
  onSave: Save<ProjectInput>
  onDelete?: () => void
  onClose: () => void
}) {
  const start = project ?? initial
  const [f, setF] = useState({
    name: start.name,
    client: start.client ?? '',
    type: start.project_type,
    archived: start.state === 'archived',
    starts: start.starts_at,
    ends: start.ends_at,
    owner: start.project_owner_id ?? '',
    budgetType: start.budget_type,
    budgetAmount: start.budget_amount === null ? '' : String(start.budget_amount),
    budgetDays: start.budget_days === null ? '' : String(start.budget_days),
    tags: start.tags.join(', '),
    sheet: start.sheet_id ?? '',
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
  const { busy, error, submit } = useSubmit(onSave, onClose)

  function build(): ProjectInput | string {
    if (!f.name.trim()) return 'Project name is required'
    if (!ISO.test(f.starts) || !ISO.test(f.ends)) return 'Enter start and end dates'
    if (f.ends < f.starts) return 'The end date must be on or after the start date'
    const amount = f.budgetAmount.trim() === '' ? null : Number(f.budgetAmount)
    const days = f.budgetDays.trim() === '' ? null : Number(f.budgetDays)
    if (f.budgetType === 'amount' && !(amount !== null && amount >= 0)) return 'Enter a budget amount of 0 or more'
    if (f.budgetType === 'days' && !(days !== null && days >= 0)) return 'Enter a budget in days of 0 or more'
    return {
      name: f.name.trim(),
      client: orNull(f.client),
      project_type: f.type,
      state: f.archived ? 'archived' : 'active',
      starts_at: f.starts,
      ends_at: f.ends,
      project_owner_id: f.owner || null,
      budget_type: f.budgetType,
      budget_amount: f.budgetType === 'amount' ? amount : null,
      budget_days: f.budgetType === 'days' ? days : null,
      tags: parseTags(f.tags),
      sheet_id: f.sheet || null,
    }
  }

  return (
    <Modal
      title={project ? `Edit ${project.name}` : 'New project'}
      submitLabel={project ? 'Save' : 'Create project'}
      onClose={onClose}
      onSubmit={() => void submit(build())}
      busy={busy}
      error={error}
      extraActions={
        onDelete && (
          <button type="button" className="rm-danger-link" onClick={onDelete}>
            Delete project
          </button>
        )
      }
    >
      <div className="rm-grid-2">
        <Field label="Project name">
          <input value={f.name} onChange={set('name')} required />
        </Field>
        <Field label="Client">
          <input value={f.client} onChange={set('client')} />
        </Field>
        <Field label="Project type">
          <select value={f.type} onChange={(e) => setF((x) => ({ ...x, type: e.target.value as ProjectType }))}>
            {Object.entries(PROJECT_TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Project owner">
          <select value={f.owner} onChange={set('owner')}>
            <option value="">[none]</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {fullName(p)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Starts">
          <input type="date" value={f.starts} onChange={set('starts')} />
        </Field>
        <Field label="Ends">
          <input type="date" value={f.ends} onChange={set('ends')} />
        </Field>
        <Field label="Budget tracking">
          <select value={f.budgetType} onChange={(e) => setF((x) => ({ ...x, budgetType: e.target.value as BudgetType }))}>
            <option value="none">Not tracked</option>
            <option value="amount">Currency</option>
            <option value="days">Days</option>
          </select>
        </Field>
        {f.budgetType === 'amount' && (
          <Field label="Budget amount">
            <input type="number" min="0" step="100" value={f.budgetAmount} onChange={set('budgetAmount')} />
          </Field>
        )}
        {f.budgetType === 'days' && (
          <Field label="Budget (person-days)">
            <input type="number" min="0" step="0.5" value={f.budgetDays} onChange={set('budgetDays')} />
          </Field>
        )}
        {f.budgetType === 'none' && <span />}
        <Field label="Linked sheet">
          <select value={f.sheet} onChange={set('sheet')}>
            <option value="">[none]</option>
            {sheets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tags" hint="Comma-separated">
          <input value={f.tags} onChange={set('tags')} />
        </Field>
        <label className="rm-check">
          <input type="checkbox" checked={f.archived} onChange={(e) => setF((x) => ({ ...x, archived: e.target.checked }))} />
          Archived
        </label>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------- Assignment

export function AssignmentDialog({
  assignment,
  initial,
  people,
  projects,
  onSave,
  onDelete,
  onClose,
}: {
  assignment: Assignment | null
  initial: Partial<AssignmentInput>
  people: Person[]
  projects: Project[]
  onSave: Save<AssignmentInput>
  onDelete?: () => void
  onClose: () => void
}) {
  const start = assignment ?? initial
  const [f, setF] = useState({
    person: start.person_id ?? people[0]?.id ?? '',
    project: start.project_id ?? projects[0]?.id ?? '',
    starts: start.starts_at ?? '',
    ends: start.ends_at ?? start.starts_at ?? '',
    percent: String(start.allocation_percent ?? 100),
    tentative: start.status === 'tentative',
    notes: start.notes ?? '',
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
  const { busy, error, submit } = useSubmit(onSave, onClose)
  const project = projects.find((p) => p.id === f.project)

  function build(): AssignmentInput | string {
    if (!f.person) return 'Choose a person'
    if (!f.project) return 'Choose a project'
    if (!ISO.test(f.starts) || !ISO.test(f.ends)) return 'Enter start and end dates'
    if (f.ends < f.starts) return 'The end date must be on or after the start date'
    const pct = Number(f.percent)
    if (!(pct > 0 && pct <= 200)) return 'Allocation must be between 1% and 200%'
    return {
      person_id: f.person,
      project_id: f.project,
      starts_at: f.starts,
      ends_at: f.ends,
      allocation_percent: pct,
      status: f.tentative ? 'tentative' : 'confirmed',
      notes: orNull(f.notes),
    }
  }

  return (
    <Modal
      title={assignment ? 'Edit assignment' : 'New assignment'}
      submitLabel={assignment ? 'Save' : 'Assign'}
      onClose={onClose}
      onSubmit={() => void submit(build())}
      busy={busy}
      error={error}
      extraActions={
        onDelete && (
          <button type="button" className="rm-danger-link" onClick={onDelete}>
            Remove assignment
          </button>
        )
      }
    >
      <div className="rm-grid-2">
        <Field label="Person">
          <select value={f.person} onChange={set('person')}>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {fullName(p)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Project" hint={project ? `${usDate(project.starts_at)} – ${usDate(project.ends_at)}` : undefined}>
          <select value={f.project} onChange={set('project')}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Starts">
          <input type="date" value={f.starts} onChange={set('starts')} />
        </Field>
        <Field label="Ends">
          <input type="date" value={f.ends} onChange={set('ends')} />
        </Field>
        <Field label="Allocation (%)" hint="Share of the person's working day">
          <input type="number" min="1" max="200" step="5" value={f.percent} onChange={set('percent')} />
        </Field>
        <label className="rm-check">
          <input type="checkbox" checked={f.tentative} onChange={(e) => setF((x) => ({ ...x, tentative: e.target.checked }))} />
          Tentative
        </label>
        <Field label="Notes">
          <input value={f.notes} onChange={set('notes')} />
        </Field>
      </div>
    </Modal>
  )
}
