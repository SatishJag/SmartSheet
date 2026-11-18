import { generateKeyBetween } from 'fractional-indexing'
import { defaultCalendar, nextWorkingDay } from '../engine/calendar'
import { formatDuration } from '../engine/duration'
import { schedule, type SchedDep } from '../engine/schedule'
import type { Column } from '../model/validate'
import type { RowRecord, SheetData } from '../store/persistence'
import { toSchedInput } from '../store/scheduleInput'
import { STATUS_OPTIONS } from '../templates/presets'
import type { ColumnSpec } from '../templates/projectSchedule'
import { workingDays } from '../rm/dates'
import type { AssignmentInput, Person, PersonInput, ProjectInput } from '../rm/types'
import type { AppTemplate, SupportSheet } from './types'

export interface AppOptions {
  projectName: string
  client: string | null
  /** ISO date; moved to the next working day. */
  startDate: string
  ownerId: string
  /** Also create the project, placeholder roles and assignments in Resource Management. */
  withResources: boolean
}

export interface BuiltApp {
  /** The plan sheet first, then the supporting sheets. */
  sheets: SheetData[]
  planSheetId: string
  starts_at: string
  ends_at: string
  /** Null when withResources is off. */
  resources: {
    project: Omit<ProjectInput, 'sheet_id'>
    /** Roles that need a new placeholder person (existing placeholders with the role are reused). */
    newPeople: PersonInput[]
    /** person_id holds the role name until the people exist; see `resolveAssignments`. */
    assignments: (Omit<AssignmentInput, 'project_id' | 'person_id'> & { role: string })[]
  } | null
}

const PLAN_COLUMNS = (disciplines: string[]): ColumnSpec[] => [
  { title: 'Task', type: 'TEXT_NUMBER' },
  { title: 'Discipline', type: 'PICKLIST', options: [...disciplines] },
  { title: 'Role', type: 'TEXT_NUMBER' },
  { title: 'Assigned To', type: 'CONTACT_LIST' },
  { title: 'Duration', type: 'DURATION', role: 'duration' },
  { title: 'Start', type: 'DATE', role: 'start' },
  { title: 'End', type: 'DATE', role: 'end' },
  { title: 'Predecessors', type: 'PREDECESSOR', role: 'predecessor' },
  { title: 'Status', type: 'PICKLIST', options: [...STATUS_OPTIONS], role: 'status' },
  { title: '% Complete', type: 'TEXT_NUMBER', role: 'percentComplete' },
]

function newSheet(name: string, specs: ColumnSpec[], ownerId: string, dependenciesEnabled: boolean): SheetData {
  return {
    sheet: {
      id: crypto.randomUUID(),
      name,
      ownerId,
      workspaceId: ownerId,
      calendar: { ...defaultCalendar, workingWeekdays: [...defaultCalendar.workingWeekdays], nonWorkingDates: [] },
      dependenciesEnabled,
    },
    columns: specs.map((c) => ({ ...c, ...(c.options ? { options: [...c.options] } : {}), id: crypto.randomUUID() }) as Column),
    rows: [],
    dependencies: [],
  }
}

/** Positions for n siblings in order. */
function positions(n: number): string[] {
  const out: string[] = []
  let prev: string | null = null
  for (let i = 0; i < n; i++) {
    prev = generateKeyBetween(prev, null)
    out.push(prev)
  }
  return out
}

function supportSheet(spec: SupportSheet, prefix: string, ownerId: string): SheetData {
  const data = newSheet(`${prefix} – ${spec.name}`, spec.columns, ownerId, false)
  const colByTitle = new Map(data.columns.map((c) => [c.title, c.id]))
  const pos = positions(spec.rows.length)
  data.rows = spec.rows.map((values, i) => {
    const cells: Record<string, unknown> = {}
    for (const [title, v] of Object.entries(values)) {
      const id = colByTitle.get(title)
      if (!id) throw new Error(`Template "${spec.name}" has no column "${title}"`)
      cells[id] = v
    }
    return { id: crypto.randomUUID(), parentId: null, position: pos[i], cells, version: 0 }
  })
  return data
}

/**
 * Builds every sheet of an app template (with ids, rows, scheduled dates and dependencies) and
 * the matching Resource Management records. Pure apart from random ids.
 */
export function buildApp(template: AppTemplate, opts: AppOptions, existingPeople: readonly Person[] = []): BuiltApp {
  const prefix = opts.projectName.trim() || template.name
  const start = nextWorkingDay(defaultCalendar, opts.startDate)
  const plan = newSheet(`${prefix} – Project plan`, PLAN_COLUMNS(template.disciplines), opts.ownerId, true)
  const col = (title: string) => plan.columns.find((c) => c.title === title)!.id
  const [cTask, cDisc, cRole, cDur, cStart, cEnd, cStatus] = ['Task', 'Discipline', 'Role', 'Duration', 'Start', 'End', 'Status'].map(col)

  const rows: RowRecord[] = []
  const deps: SchedDep[] = []
  const taskMeta = new Map<string, { phase: string; role?: string }>()
  // The current group of tasks running side by side (a task and the `parallel` ones after it).
  // The next sequential task waits for the whole group; a parallel task shares the group's preds.
  let group: string[] = []
  let groupPreds: string[] = []
  // Tasks with explicit `after` links: resolved once every task has an id, so a link may point
  // forward in the plan. They take no part in the sequential / parallel grouping above.
  const idByKey = new Map<string, string>()
  const explicit: { id: string; name: string; after: string[] }[] = []
  const phasePos = positions(template.plan.length)
  template.plan.forEach((phase, pi) => {
    const phaseId = crypto.randomUUID()
    rows.push({ id: phaseId, parentId: null, position: phasePos[pi], cells: { [cTask]: phase.name }, version: 0 })
    const taskPos = positions(phase.tasks.length)
    phase.tasks.forEach((t, ti) => {
      const id = crypto.randomUUID()
      if (t.key !== undefined) {
        if (idByKey.has(t.key)) throw new Error(`Template "${template.name}" has two tasks with key "${t.key}"`)
        idByKey.set(t.key, id)
      }
      const preds: string[] = t.after ? [] : t.parallel && group.length > 0 ? groupPreds : group
      const cells: Record<string, unknown> = {
        [cTask]: t.name,
        [cDur]: formatDuration({ minutes: t.days * defaultCalendar.hoursPerDay * 60, elapsed: false }),
        [cStatus]: 'Not started',
      }
      if (t.discipline) cells[cDisc] = t.discipline
      if (t.role) cells[cRole] = t.role
      if ((t.after ? t.after.length : preds.length) === 0) cells[cStart] = start
      rows.push({ id, parentId: phaseId, position: taskPos[ti], cells, version: 0 })
      taskMeta.set(id, { phase: phase.name, role: t.role })
      if (t.after) {
        explicit.push({ id, name: t.name, after: t.after })
        return
      }
      for (const p of preds) deps.push({ predecessorId: p, successorId: id, type: 'FS', lagMinutes: 0 })
      if (t.parallel && group.length > 0) group = [...group, id]
      else {
        group = [id]
        groupPreds = preds
      }
    })
  })
  for (const e of explicit) {
    for (const key of new Set(e.after)) {
      const predecessorId = idByKey.get(key)
      if (!predecessorId) throw new Error(`Template "${template.name}": task "${e.name}" comes after unknown task "${key}"`)
      deps.push({ predecessorId, successorId: e.id, type: 'FS', lagMinutes: 0 })
    }
  }
  plan.rows = rows
  plan.dependencies = deps

  // Let the app's own engine place every task, so the stored dates match what the Gantt shows.
  const input = toSchedInput(plan)!
  const result = schedule(input.rows, input.deps, input.calendar)
  if (result.errors.length > 0) throw new Error(`Template "${template.name}" does not schedule: ${result.errors[0].message}`)
  for (const r of plan.rows) {
    const s = result.byRow[r.id]
    r.cells = { ...r.cells, [cStart]: s.start, [cEnd]: s.end }
  }
  const all = Object.values(result.byRow)
  const ends_at = all.reduce((m, s) => (s.end > m ? s.end : m), start)

  const sheets = [plan, ...template.supportSheets.map((s) => supportSheet(s, prefix, opts.ownerId))]

  let resources: BuiltApp['resources'] = null
  if (opts.withResources) {
    // One assignment per (phase, role): from the role's first task start to its last task end.
    const spans = new Map<string, { role: string; start: string; end: string; days: number }>()
    for (const [id, meta] of taskMeta) {
      if (!meta.role) continue
      const s = result.byRow[id]
      const key = `${meta.phase}|${meta.role}`
      const cur = spans.get(key)
      const days = s.durationDays
      if (!cur) spans.set(key, { role: meta.role, start: s.start, end: s.end, days })
      else {
        cur.start = s.start < cur.start ? s.start : cur.start
        cur.end = s.end > cur.end ? s.end : cur.end
        cur.days += days
      }
    }
    const assignments = [...spans.values()].map((sp) => {
      // Allocation is the share of the span the role is actually busy (at least 10%).
      const span = Math.max(1, workingDays(sp.start, sp.end))
      const pct = Math.min(100, Math.max(10, Math.round(((sp.days || 1) / span) * 100 / 5) * 5))
      return { role: sp.role, starts_at: sp.start, ends_at: sp.end, allocation_percent: pct, status: 'confirmed' as const, notes: null }
    })
    const budgetDays = assignments.reduce((sum, a) => sum + (workingDays(a.starts_at, a.ends_at) * a.allocation_percent) / 100, 0)
    const reused = new Set(existingPeople.filter((p) => p.member_type === 'placeholder' && p.role).map((p) => p.role!))
    const neededRoles = [...new Set(assignments.map((a) => a.role))]
    resources = {
      project: {
        name: prefix,
        client: opts.client,
        project_type: 'confirmed',
        state: 'active',
        starts_at: start,
        ends_at,
        project_owner_id: null,
        budget_type: 'days',
        budget_amount: null,
        budget_days: Math.round(budgetDays),
        tags: [template.name],
      },
      newPeople: neededRoles
        .filter((r) => !reused.has(r))
        .map((role) => ({
          first_name: role,
          last_name: '',
          email: null,
          role,
          discipline: null,
          location: null,
          tags: ['placeholder'],
          capacity_hours_per_day: 8,
          bill_rate: 0,
          office_status: null,
          member_type: 'placeholder' as const,
          is_approver: false,
        })),
      assignments,
    }
  }

  return { sheets, planSheetId: plan.sheet.id, starts_at: start, ends_at, resources }
}
