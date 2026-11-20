/**
 * A planner sheet as the WhatsApp assistant sees it: one fact sheet per row (dates, progress, delay,
 * float, priority, owners), computed with the planner's own scheduling engine so that float and the
 * critical path are the numbers the Gantt shows. Pure; used by the server and by tests.
 *
 * Columns are found by role where the planner has one (start, end, duration, % complete, status),
 * the task-owner column by the sheet's WhatsApp setting or else by title, and the rest by title (as
 * the WBS9 bot matched Smartsheet columns).
 */
import { emailsIn, formatValue } from '../automation/values'
import { analyzeCriticalPath } from '../engine/criticalPath'
import { schedule } from '../engine/schedule'
import { formatFormulaValue, formulaEvaluator } from '../formula/sheetFormulas'
import { fullOrder } from '../model/hierarchy'
import type { Column } from '../model/validate'
import type { SheetData } from '../store/persistence'
import { toSchedInput } from '../store/scheduleInput'
import { addDays, daysBetween } from './time'

export type Priority = 'HIGH' | 'MEDIUM' | 'LOW'

export interface SheetColumns {
  name: string
  start?: string
  end?: string
  duration?: string
  percent?: string
  status?: string
  owner?: string
  department?: string
  comments?: string
  type?: string
}

export interface TaskFact {
  rowId: string
  /** The row number the grid shows (1-based, sheet order). */
  number: number
  name: string
  parentName: string | null
  /** Has child rows: a summary (rolled-up) row, left out of task lists and alerts. */
  summary: boolean
  start: string | null
  finish: string | null
  durationDays: number | null
  /** 0..100, null when the sheet has no % complete column or the cell is empty. */
  percent: number | null
  status: string
  complete: boolean
  milestone: boolean
  /** Days past the finish date while not complete (0 when not late). */
  delayDays: number
  /** Days from today to the finish date (negative when past), null without a finish. */
  daysToFinish: number | null
  /** Working days; null when the sheet has no dependency network to compute it from. */
  totalFloat: number | null
  critical: boolean
  priority: Priority
  /** E-mail addresses in the task-owner column (lower case). */
  owners: string[]
  department: string
  /** Expected finish when progress says the planned finish will be missed; null otherwise. */
  forecastFinish: string | null
}

export interface SheetFacts {
  columns: SheetColumns
  tasks: TaskFact[]
  /** Leaf rows only (no summaries): what lists, counts and alerts use. */
  work: TaskFact[]
  /** Whether float was computed (dependencies on and a start column). */
  hasFloat: boolean
}

/** Float at or under this many working days is MEDIUM priority (0 is HIGH, as in the WBS9 bot). */
export const FLOAT_MEDIUM_DAYS = 14

const DONE_RE = /^(complete|completed|done|closed|finished|approved|100%?)$/i
const OWNER_TITLE_RE = /owner|responsib|assign|accountab|lead|foreman|contractor|in charge/i
const DEPT_TITLE_RE = /^(department|dept|team|trade|discipline|phase)$/i
const COMMENT_TITLE_RE = /comment|remark|note/i
const TYPE_TITLE_RE = /^(activity type|type|task type)$/i

export function findColumns(columns: Column[], ownerColumnId?: string | null): SheetColumns {
  const byRole = (role: Column['role']) => columns.find((c) => c.role === role)?.id
  const contacts = columns.filter((c) => c.type === 'CONTACT_LIST')
  const owner =
    (ownerColumnId && contacts.find((c) => c.id === ownerColumnId)?.id) ||
    contacts.find((c) => OWNER_TITLE_RE.test(c.title))?.id ||
    contacts[0]?.id
  const byTitle = (re: RegExp, skip: (string | undefined)[] = []) =>
    columns.find((c, i) => i > 0 && re.test(c.title.trim()) && !skip.includes(c.id) && !c.role)?.id
  return {
    name: columns[0]?.id ?? '',
    start: byRole('start'),
    end: byRole('end'),
    duration: byRole('duration'),
    percent: byRole('percentComplete'),
    status: byRole('status'),
    owner,
    department: byTitle(DEPT_TITLE_RE),
    comments: columns.find((c) => c.type === 'TEXT_NUMBER' && COMMENT_TITLE_RE.test(c.title) && !c.role)?.id,
    type: byTitle(TYPE_TITLE_RE),
  }
}

export function isDoneStatus(status: string): boolean {
  return DONE_RE.test(status.trim())
}

export function priorityOf(totalFloat: number | null): Priority {
  if (totalFloat === null) return 'MEDIUM'
  if (totalFloat <= 0) return 'HIGH'
  return totalFloat <= FLOAT_MEDIUM_DAYS ? 'MEDIUM' : 'LOW'
}

const isoOrNull = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null)

export function sheetFacts(data: SheetData, today: string, opts: { ownerColumnId?: string | null } = {}): SheetFacts {
  const columns = findColumns(data.columns, opts.ownerColumnId)
  const colById = new Map(data.columns.map((c) => [c.id, c]))
  const evaluate = formulaEvaluator(data)
  const value = (rowId: string, cells: Record<string, unknown>, colId: string | undefined): unknown => {
    if (!colId) return undefined
    const res = evaluate(rowId, colId)
    if (res) return res.ok ? res.value : undefined
    return cells[colId]
  }
  const text = (v: unknown, col?: Column) => {
    if (v === undefined || v === null) return ''
    if (col?.type === 'CHECKBOX') return v === true ? 'Yes' : ''
    return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? formatFormulaValue(v) : formatValue(v)
  }

  const input = toSchedInput(data)
  const sched = input ? schedule(input.rows, input.deps, input.calendar) : null
  const cp = input && sched && data.sheet.dependenciesEnabled && input.deps.length > 0 ? analyzeCriticalPath(input.rows, input.deps, input.calendar, sched) : null

  const byId = new Map(data.rows.map((r) => [r.id, r]))
  const hasChildren = new Set(data.rows.flatMap((r) => (r.parentId ? [r.parentId] : [])))
  const order = fullOrder(data.rows)
  const nameOf = (rowId: string) => {
    const r = byId.get(rowId)
    return r ? text(value(r.id, r.cells, columns.name)).trim() : ''
  }

  const tasks: TaskFact[] = order.map((id, i) => {
    const r = byId.get(id)!
    const s = sched?.byRow[id]
    const start = s?.start ?? isoOrNull(value(id, r.cells, columns.start))
    const finish = s?.end ?? isoOrNull(value(id, r.cells, columns.end))
    const rawPct = value(id, r.cells, columns.percent)
    const percent = typeof rawPct === 'number' && Number.isFinite(rawPct) ? Math.max(0, Math.min(100, rawPct)) : null
    const statusCol = columns.status ? colById.get(columns.status) : undefined
    const rawStatus = value(id, r.cells, columns.status)
    const status = text(rawStatus, statusCol).trim()
    const complete = (statusCol?.type === 'CHECKBOX' ? rawStatus === true : isDoneStatus(status)) || percent === 100
    const durationDays = s ? s.durationDays : start && finish ? Math.max(0, daysBetween(start, finish) + 1) : null
    const typeText = text(value(id, r.cells, columns.type)).toLowerCase()
    const milestone = (s ? s.durationDays === 0 : false) || typeText.includes('milestone')
    const daysToFinish = finish ? daysBetween(today, finish) : null
    const delayDays = !complete && daysToFinish !== null && daysToFinish < 0 ? -daysToFinish : 0
    const info = cp?.byRow[id]
    const totalFloat = info ? info.totalFloat : null
    const owners = columns.owner ? [...new Set(emailsIn(r.cells[columns.owner]).map((e) => e.toLowerCase()))] : []
    let forecastFinish: string | null = null
    if (!complete && start && finish && percent !== null && durationDays !== null && today > start) {
      const remaining = Math.ceil(Math.max(durationDays, 1) * (1 - percent / 100))
      const projected = addDays(today, remaining)
      if (projected > finish) forecastFinish = projected
    }
    return {
      rowId: id,
      number: i + 1,
      name: nameOf(id) || `Row ${i + 1}`,
      parentName: r.parentId ? nameOf(r.parentId) || null : null,
      summary: hasChildren.has(id),
      start,
      finish,
      durationDays,
      percent,
      status,
      complete,
      milestone,
      delayDays,
      daysToFinish,
      totalFloat,
      critical: info ? info.critical : false,
      priority: priorityOf(totalFloat),
      owners,
      department: text(value(id, r.cells, columns.department)).trim(),
      forecastFinish,
    }
  })
  return { columns, tasks, work: tasks.filter((t) => !t.summary), hasFloat: cp !== null }
}
