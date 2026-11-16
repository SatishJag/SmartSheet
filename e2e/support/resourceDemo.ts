/**
 * A demo backend state for the resources screens: one owner, one project sheet of ~40 tasks, a
 * dozen resources, assignments with a few deliberate over-allocations. Used to take screenshots and to
 * try the screens by hand (set `localStorage[FAKE_STORAGE_KEY]` to `JSON.stringify(resourceDemoState(...))`
 * before the app loads). Dates are relative to `monday` (a Monday, YYYY-MM-DD).
 */
import { columnToDb } from '../../src/store/persistence'
import { createSheetFromTemplate } from '../../src/templates'
import { addUser, emptyState, type DbRecord, type FakeState } from './fakeSupabase'

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

interface Task {
  name: string
  days: number
  /** Index (in this list) of the predecessor, or null. */
  after: number | null
  /** Start offset in calendar days from `monday` for tasks without a predecessor. */
  at?: number
}
interface Phase {
  name: string
  tasks: Task[]
}

const PHASES: Phase[] = [
  {
    name: 'Substructure',
    tasks: [
      { name: 'Excavate basement', days: 5, after: null, at: 0 },
      { name: 'Piling', days: 8, after: 0 },
      { name: 'Pile caps', days: 4, after: 1 },
      { name: 'Waterproofing', days: 3, after: 2 },
      { name: 'Backfill', days: 3, after: 3 },
    ],
  },
  {
    name: 'Structure',
    tasks: [
      { name: 'Ground slab', days: 5, after: null, at: 14 },
      { name: 'Columns L1 to L3', days: 10, after: 0 },
      { name: 'Slab L1', days: 4, after: 1 },
      { name: 'Slab L2', days: 4, after: 2 },
      { name: 'Slab L3', days: 4, after: 3 },
    ],
  },
  {
    name: 'Electrical',
    tasks: [
      { name: 'Conduit rough-in L1', days: 5, after: null, at: 28 },
      { name: 'Conduit rough-in L2', days: 5, after: 0 },
      { name: 'Main switchboard install', days: 6, after: null, at: 28 },
      { name: 'Cable pulling', days: 8, after: 1 },
      { name: 'Testing and commissioning', days: 5, after: 3 },
    ],
  },
  {
    name: 'Mechanical',
    tasks: [
      { name: 'Ductwork L1', days: 6, after: null, at: 28 },
      { name: 'Ductwork L2', days: 6, after: 0 },
      { name: 'Chiller delivery and set', days: 3, after: null, at: 35 },
      { name: 'Pipework', days: 9, after: 2 },
      { name: 'Balancing', days: 4, after: 3 },
    ],
  },
  {
    name: 'Fit-out',
    tasks: [
      { name: 'Partitions L1', days: 7, after: null, at: 49 },
      { name: 'Ceilings L1', days: 6, after: 0 },
      { name: 'Joinery', days: 8, after: 1 },
      { name: 'Painting', days: 5, after: 2 },
      { name: 'Snagging', days: 4, after: 3 },
    ],
  },
]

const RESOURCES: { name: string; kind: 'person' | 'role' | 'equipment'; dept: string; skills: string[]; rate: number; hours?: number[]; off?: [number, number, number][] }[] = [
  { name: 'Ada Okafor', kind: 'person', dept: 'Electrical', skills: ['Wiring', 'Testing'], rate: 62, off: [[40, 44, 0]] },
  { name: 'Ben Hartley', kind: 'person', dept: 'Site management', skills: ['Planning', 'Safety'], rate: 70 },
  { name: 'Chen Wei', kind: 'person', dept: 'Civil', skills: ['Concrete', 'Piling'], rate: 58 },
  { name: 'Dina Rossi', kind: 'person', dept: 'Commercial', skills: ['Quantities'], rate: 54, hours: [0, 8, 8, 8, 8, 4, 0] },
  { name: 'Eli Brandt', kind: 'person', dept: 'Electrical', skills: ['Wiring'], rate: 45 },
  { name: 'Fatima Noor', kind: 'person', dept: 'Mechanical', skills: ['Pipework', 'Welding'], rate: 48 },
  { name: 'Gus Moreno', kind: 'person', dept: 'Civil', skills: ['Crane'], rate: 50, off: [[10, 12, 0]] },
  { name: 'Hana Ito', kind: 'person', dept: 'Mechanical', skills: ['Ductwork', 'Balancing'], rate: 52 },
  { name: 'Site safety officer', kind: 'role', dept: 'Site management', skills: ['Safety'], rate: 44 },
  { name: 'Electrical foreman', kind: 'role', dept: 'Electrical', skills: ['Wiring', 'Supervision'], rate: 56 },
  { name: 'Tower crane', kind: 'equipment', dept: 'Plant', skills: ['Lifting'], rate: 120, hours: [0, 10, 10, 10, 10, 10, 0] },
  { name: 'Concrete pump', kind: 'equipment', dept: 'Plant', skills: ['Concrete'], rate: 95, hours: [0, 10, 10, 10, 10, 10, 0] },
]

// [task name, resource name, kind, value]
const ASSIGN: [string, string, 'percent' | 'hours_per_day' | 'hours_per_week' | 'total_hours', number][] = [
  ['Excavate basement', 'Gus Moreno', 'percent', 100],
  ['Excavate basement', 'Ben Hartley', 'percent', 25],
  ['Piling', 'Chen Wei', 'percent', 100],
  ['Piling', 'Tower crane', 'percent', 60],
  ['Pile caps', 'Chen Wei', 'percent', 75],
  ['Waterproofing', 'Chen Wei', 'percent', 50],
  ['Ground slab', 'Chen Wei', 'percent', 100],
  ['Ground slab', 'Concrete pump', 'percent', 100],
  ['Columns L1 to L3', 'Chen Wei', 'percent', 80],
  ['Columns L1 to L3', 'Tower crane', 'percent', 90],
  ['Slab L1', 'Concrete pump', 'hours_per_day', 8],
  ['Slab L1', 'Tower crane', 'percent', 70],
  ['Conduit rough-in L1', 'Ada Okafor', 'percent', 100],
  ['Conduit rough-in L1', 'Eli Brandt', 'percent', 100],
  ['Conduit rough-in L2', 'Eli Brandt', 'percent', 100],
  ['Main switchboard install', 'Ada Okafor', 'percent', 75],
  ['Main switchboard install', 'Electrical foreman', 'hours_per_day', 4],
  ['Cable pulling', 'Eli Brandt', 'percent', 100],
  ['Cable pulling', 'Ada Okafor', 'percent', 50],
  ['Testing and commissioning', 'Ada Okafor', 'percent', 100],
  ['Ductwork L1', 'Hana Ito', 'percent', 100],
  ['Ductwork L2', 'Hana Ito', 'percent', 100],
  ['Chiller delivery and set', 'Tower crane', 'percent', 100],
  ['Chiller delivery and set', 'Fatima Noor', 'percent', 50],
  ['Pipework', 'Fatima Noor', 'percent', 100],
  ['Balancing', 'Hana Ito', 'total_hours', 24],
  ['Partitions L1', 'Ben Hartley', 'percent', 40],
  ['Snagging', 'Site safety officer', 'percent', 50],
  ['Excavate basement', 'Site safety officer', 'hours_per_week', 12],
  ['Joinery', 'Dina Rossi', 'percent', 30],
]

export function resourceDemoState(monday: string): FakeState {
  const state = emptyState()
  const user = addUser(state, 'demo@example.com', 'demo-password')
  state.sessionUserId = user.id
  const own = { owner_id: user.id, workspace_id: user.id }
  const data = createSheetFromTemplate('project-schedule', user.id)
  data.sheet.name = 'Riverside Hospital'
  data.sheet.dependenciesEnabled = true
  state.tables.sheets.push({
    id: data.sheet.id,
    ...own,
    name: data.sheet.name,
    calendar: data.sheet.calendar,
    dependencies_enabled: true,
    created_at: new Date().toISOString(),
  })
  data.columns.forEach((c, i) => state.tables.columns.push(columnToDb(c, i, data.sheet) as unknown as DbRecord))
  const col = (role: string) => data.columns.find((c) => c.role === role)!.id
  const nameCol = data.columns[0].id
  const [start, dur] = [col('start'), col('duration')]

  const taskRow = new Map<string, string>()
  let pos = 0
  const pad = () => `a${String(pos++).padStart(3, '0')}`
  for (const phase of PHASES) {
    const phaseId = crypto.randomUUID()
    state.tables.rows.push({ id: phaseId, sheet_id: data.sheet.id, ...own, parent_id: null, position: pad(), cells: { [nameCol]: phase.name }, version: 0 })
    const ids: string[] = []
    phase.tasks.forEach((t) => {
      const id = crypto.randomUUID()
      ids.push(id)
      taskRow.set(t.name, id)
      const cells: Record<string, unknown> = { [nameCol]: t.name, [dur]: `${t.days}d` }
      if (t.after === null) cells[start] = addDays(monday, t.at ?? 0)
      state.tables.rows.push({ id, sheet_id: data.sheet.id, ...own, parent_id: phaseId, position: pad(), cells, version: 0 })
      if (t.after !== null) {
        state.tables.dependencies.push({
          id: crypto.randomUUID(),
          sheet_id: data.sheet.id,
          ...own,
          predecessor_row_id: ids[t.after],
          successor_row_id: id,
          type: 'FS',
          lag_minutes: 0,
        })
      }
    })
  }

  const resId = new Map<string, string>()
  for (const r of RESOURCES) {
    const id = crypto.randomUUID()
    resId.set(r.name, id)
    state.tables.resources.push({
      id,
      ...own,
      name: r.name,
      kind: r.kind,
      department: r.dept,
      skills: r.skills,
      cost_rate: r.rate,
      hours_by_weekday: r.hours ?? [0, 8, 8, 8, 8, 8, 0],
      created_at: new Date().toISOString(),
    })
    for (const [a, b, h] of r.off ?? []) {
      state.tables.resource_time_off.push({ id: crypto.randomUUID(), resource_id: id, ...own, start_date: addDays(monday, a), end_date: addDays(monday, b), hours: h, note: 'Leave', created_at: new Date().toISOString() })
    }
  }
  for (const [task, res, kind, value] of ASSIGN) {
    state.tables.assignments.push({
      id: crypto.randomUUID(),
      sheet_id: data.sheet.id,
      ...own,
      row_id: taskRow.get(task)!,
      resource_id: resId.get(res)!,
      allocation_kind: kind,
      allocation_value: value,
      start_date: null,
      end_date: null,
      created_at: new Date().toISOString(),
    })
  }
  return state
}
