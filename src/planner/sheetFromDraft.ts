import type { SupabaseClient } from '@supabase/supabase-js'
import { generateNKeysBetween } from 'fractional-indexing'
import { formatDuration } from '../engine/duration'
import type { SchedDep } from '../engine/schedule'
import type { Calendar } from '../engine/types'
import { MAX_SHEET_NAME_LENGTH } from '../auth/sheetName'
import type { Column } from '../model/validate'
import { columnToDb, dependencyToDb, rowToDb, type RowRecord, type SheetData, type SheetMeta } from '../store/persistence'
import { createSheetFromTemplate } from '../templates'
import { daysToMinutes, planBackward, todayIso, type BackwardPlan } from './backward'
import type { DraftActivity, HistorySummary, PlanDraft } from './types'

/** Title of the extra text column that says where each duration came from. */
export const BASIS_COLUMN_TITLE = 'Basis'

const NAME_PREFIX: Record<string, string> = { 'lle-procurement': 'LLE', 'property-development': 'Programme' }

/** Title of the Procore cost code dropdown column (docs/superpowers/specs/2026-11-21-cost-code-link-design.md). */
export const COST_CODE_COLUMN_TITLE = 'Cost code'

/**
 * The Cost code column a plan sheet gets: its dropdown options ("GEN — Generator") and, per draft in
 * draft order, the option to fill in (undefined: none). A value not among the options is left out.
 */
export interface CostCodeColumn {
  options: string[]
  values: (string | undefined)[]
}

/** Title of the Procore project dropdown column (one project per plan). */
export const PROJECT_COLUMN_TITLE = 'Procore project'

/**
 * The Procore project column a plan sheet gets: its dropdown options ("BKK-03 — Bangkok 3") and the
 * plan's project (undefined: none chosen). A value not among the options is left out.
 */
export interface ProjectColumn {
  options: string[]
  value?: string
}

/** Titles of the optional columns a catalog's reference details fill (property development template). */
export const ACTIVITY_ID_COLUMN_TITLE = 'Activity ID'
export const RESPONSIBILITY_COLUMN_TITLE = 'Lead responsibility'
export const CRITERIA_COLUMN_TITLE = 'Completion / release criteria'

const clip = (name: string, max: number) => (name.length > max ? `${name.slice(0, max - 1)}…` : name)

/** "LLE – 400 MVA transformer" (at most the sheet-name limit). */
export function sheetNameForDraft(draft: PlanDraft): string {
  const prefix = NAME_PREFIX[draft.request.scheduleType] ?? 'Plan'
  return clip(`${prefix} – ${draft.request.equipmentName.trim() || draft.request.equipmentType}`, MAX_SHEET_NAME_LENGTH)
}

/** One draft: its own name ("LLE – 400 MVA transformer"); several: "LLE plan – 3 items". */
export function sheetNameForDrafts(drafts: PlanDraft[]): string {
  if (drafts.length === 1) return sheetNameForDraft(drafts[0])
  const prefix = NAME_PREFIX[drafts[0].request.scheduleType]
  return clip(`${prefix ? `${prefix} plan` : 'Plan'} – ${drafts.length} items`, MAX_SHEET_NAME_LENGTH)
}

/** The summary row's name for one item of a combined plan: "Power transformer — 400 MVA transformer, Substation B". */
export function itemRowName(draft: PlanDraft): string {
  const type = draft.request.equipmentType.trim()
  const name = draft.request.equipmentName.trim()
  if (!name) return type
  if (!type || name.toLowerCase().includes(type.toLowerCase())) return name
  return `${type} — ${name}`
}

/** Where a duration came from, for the Basis column: "p80 of 9 projects", "adjusted: ...". */
export function basisText(activity: DraftActivity, history: HistorySummary): string {
  const sample = history.sampleOnly ? ' (sample data)' : ''
  switch (activity.basis) {
    case 'p50':
    case 'p80': {
      const n = history.stats.find((s) => s.code === activity.code)?.n ?? history.projectCount
      if (n === 0) return `${activity.basis}${sample}`
      return `${activity.basis} of ${n} project${n === 1 ? '' : 's'}${sample}`
    }
    case 'default':
      return 'default (no history)'
    case 'adjusted':
      return `adjusted: ${activity.reason}${sample}`
  }
}

/** The Basis text of an item's summary row: where its whole draft came from. */
function itemSourceText(draft: PlanDraft): string {
  const n = draft.history.projectCount
  const sample = draft.history.sampleOnly ? ' (sample data)' : ''
  const from = n === 0 ? 'no history' : `${n} project${n === 1 ? '' : 's'}`
  return `${draft.source === 'ai' ? 'AI draft' : 'History draft'} from ${from}${sample}`
}

/**
 * A new sheet with the Project schedule template's columns plus "Basis", and the ids of the columns the
 * plan fills. When the drafts carry catalog reference details, "Activity ID" follows the task name and
 * "Lead responsibility" and "Completion / release criteria" come before "Basis".
 */
function newPlanSheet(
  name: string,
  ownerId: string,
  calendar: Calendar,
  drafts: PlanDraft[] = [],
  costCodeOptions: string[] = [],
  projectOptions: string[] = [],
) {
  const base = createSheetFromTemplate('project-schedule', ownerId)
  const sheet: SheetMeta = {
    ...base.sheet,
    name,
    calendar: { ...calendar, workingWeekdays: [...calendar.workingWeekdays], nonWorkingDates: [...calendar.nonWorkingDates] },
    dependenciesEnabled: true,
  }
  const basisColumn: Column = { id: crypto.randomUUID(), title: BASIS_COLUMN_TITLE, type: 'TEXT_NUMBER' }
  const has = (pick: (a: DraftActivity) => string | undefined) => drafts.some((d) => d.activities.some((a) => Boolean(pick(a))))
  const extra = (on: boolean, title: string): Column | null => (on ? { id: crypto.randomUUID(), title, type: 'TEXT_NUMBER' } : null)
  const idColumn = extra(has((a) => a.activityId), ACTIVITY_ID_COLUMN_TITLE)
  const responsibilityColumn = extra(has((a) => a.responsibility), RESPONSIBILITY_COLUMN_TITLE)
  const criteriaColumn = extra(has((a) => a.criteria), CRITERIA_COLUMN_TITLE)
  const projectColumn: Column | null =
    projectOptions.length > 0 ? { id: crypto.randomUUID(), title: PROJECT_COLUMN_TITLE, type: 'PICKLIST', options: [...projectOptions] } : null
  const costCodeColumn: Column | null =
    costCodeOptions.length > 0 ? { id: crypto.randomUUID(), title: COST_CODE_COLUMN_TITLE, type: 'PICKLIST', options: [...costCodeOptions] } : null
  const [first, ...rest] = base.columns
  const columns = [first, ...(idColumn ? [idColumn] : []), ...rest, ...(responsibilityColumn ? [responsibilityColumn] : []), ...(criteriaColumn ? [criteriaColumn] : []), ...(projectColumn ? [projectColumn] : []), ...(costCodeColumn ? [costCodeColumn] : []), basisColumn]
  const colId = (pick: (c: Column) => boolean, what: string) => {
    const col = columns.find(pick)
    if (!col) throw new Error(`The Project schedule template has no ${what} column`)
    return col.id
  }
  const cols = {
    task: columns[0].id,
    phase: colId((c) => c.title === 'Phase', 'Phase'),
    duration: colId((c) => c.role === 'duration', 'duration'),
    start: colId((c) => c.role === 'start', 'start'),
    status: colId((c) => c.role === 'status', 'status'),
    basis: basisColumn.id,
    activityId: idColumn?.id,
    responsibility: responsibilityColumn?.id,
    criteria: criteriaColumn?.id,
    costCode: costCodeColumn?.id,
    project: projectColumn?.id,
  }
  return { sheet, columns, cols }
}

type PlanCols = ReturnType<typeof newPlanSheet>['cols']

/** Draft i's cost code option, only if it is one of the column's options (the dropdown is strict). */
function costCodeValue(costCodes: CostCodeColumn | undefined, i: number): string | undefined {
  const value = costCodes?.values[i]
  return value && costCodes.options.includes(value) ? value : undefined
}

/** The plan's project option, only if it is one of the column's options (the dropdown is strict). */
function projectValue(project: ProjectColumn | undefined): string | undefined {
  const value = project?.value
  return value && project.options.includes(value) ? value : undefined
}

/** The budget-line cells an item's rows carry (Procore project and cost code), where they have a value. */
function tagCells(cols: PlanCols, project?: string, costCode?: string): Record<string, unknown> {
  return {
    ...(cols.project && project ? { [cols.project]: project } : {}),
    ...(cols.costCode && costCode ? { [cols.costCode]: costCode } : {}),
  }
}

/**
 * One draft's activity rows (draft order, children of `parentId`, or top-level when null) and the
 * dependencies between them. Dependencies are keyed by this draft's activity codes only, so two
 * drafts that use the same codes never link to each other. Only rows without predecessors carry a
 * Start (the backward-planned one).
 */
function activityRows(
  draft: PlanDraft,
  plan: BackwardPlan,
  cols: PlanCols,
  calendar: Calendar,
  parentId: string | null,
  tags: Record<string, unknown> = {},
) {
  const planned = new Map(plan.activities.map((a) => [a.code, a]))
  const positions = generateNKeysBetween(null, null, draft.activities.length)
  const rowIdByCode = new Map<string, string>()
  const rows: RowRecord[] = draft.activities.map((a, i) => {
    const id = crypto.randomUUID()
    rowIdByCode.set(a.code, id)
    const p = planned.get(a.code)
    const cells: Record<string, unknown> = {
      [cols.task]: a.name,
      [cols.phase]: a.phase,
      [cols.duration]: formatDuration({ minutes: daysToMinutes(a.durationDays, calendar), elapsed: false }, calendar.hoursPerDay),
      [cols.status]: 'Not started',
      [cols.basis]: basisText(a, draft.history),
    }
    if (cols.activityId && a.activityId) cells[cols.activityId] = a.activityId
    if (cols.responsibility && a.responsibility) cells[cols.responsibility] = a.responsibility
    if (cols.criteria && a.criteria) cells[cols.criteria] = a.criteria
    Object.assign(cells, tags)
    if (p?.isRoot) cells[cols.start] = p.start
    return { id, parentId, position: positions[i], cells, version: 0 }
  })
  const dependencies: SchedDep[] = plan.links.map((l) => ({
    predecessorId: rowIdByCode.get(l.from)!,
    successorId: rowIdByCode.get(l.to)!,
    type: l.type,
    lagMinutes: daysToMinutes(l.lagDays, calendar),
  }))
  return { rows, dependencies }
}

/**
 * The sheet a draft becomes: the Project schedule template's columns plus "Basis", one row per
 * activity in draft order, and one dependency per link. Only rows without predecessors carry a
 * Start (the backward-planned one); the engine derives every other date from the links, so the
 * sheet opens with the dates the preview showed. Pure apart from fresh ids.
 */
export function buildSheetFromDraft(
  draft: PlanDraft,
  plan: BackwardPlan,
  ownerId: string,
  calendar: Calendar,
  costCodes?: CostCodeColumn,
  project?: ProjectColumn,
): SheetData {
  const { sheet, columns, cols } = newPlanSheet(sheetNameForDraft(draft), ownerId, calendar, [draft], costCodes?.options, project?.options)
  // One item: every row belongs to it, so every row carries its project and cost code.
  const tags = tagCells(cols, projectValue(project), costCodeValue(costCodes, 0))
  const { rows, dependencies } = activityRows(draft, plan, cols, calendar, null, tags)
  return { sheet, columns, rows, dependencies }
}

/** A draft with its backward plan: what the preview shows and the sheet is built from. */
export interface PlannedDraft {
  draft: PlanDraft
  plan: BackwardPlan
}

/**
 * One sheet for several items. One item: exactly buildSheetFromDraft's flat sheet. Several: each item
 * is a summary (parent) row named after its equipment, with its activities as indented child rows
 * under it. Dependencies stay inside an item; summary rows carry no Start, Duration or
 * predecessors (the engine rolls their dates up from the children), so the sheet opens with the
 * dates of every item's preview. Pure apart from fresh ids.
 */
export function buildSheetFromDrafts(
  items: PlannedDraft[],
  ownerId: string,
  calendar: Calendar,
  costCodes?: CostCodeColumn,
  project?: ProjectColumn,
): SheetData {
  if (items.length === 0) throw new Error('There is nothing to plan')
  if (items.length === 1) return buildSheetFromDraft(items[0].draft, items[0].plan, ownerId, calendar, costCodes, project)
  const { sheet, columns, cols } = newPlanSheet(
    sheetNameForDrafts(items.map((i) => i.draft)),
    ownerId,
    calendar,
    items.map((i) => i.draft),
    costCodes?.options,
    project?.options,
  )
  const positions = generateNKeysBetween(null, null, items.length)
  const rows: RowRecord[] = []
  const dependencies: SchedDep[] = []
  items.forEach(({ draft, plan }, i) => {
    const parentId = crypto.randomUUID()
    rows.push({
      id: parentId,
      parentId: null,
      position: positions[i],
      cells: {
        [cols.task]: clip(itemRowName(draft), 200),
        [cols.status]: 'Not started',
        [cols.basis]: itemSourceText(draft),
        // Several items: project and cost code belong to the item, so only its summary row carries them.
        ...tagCells(cols, projectValue(project), costCodeValue(costCodes, i)),
      },
      version: 0,
    })
    const children = activityRows(draft, plan, cols, calendar, parentId)
    rows.push(...children.rows)
    dependencies.push(...children.dependencies)
  })
  return { sheet, columns, rows, dependencies }
}

/** Saves sheet data as a new sheet (sheet, columns, rows, dependencies, in that order); see insertSheetFromDraft. */
async function insertSheetData(client: SupabaseClient, data: SheetData): Promise<string> {
  const { sheet } = data

  const sheetRes = await client.from('sheets').insert({
    id: sheet.id,
    name: sheet.name,
    owner_id: sheet.ownerId,
    workspace_id: sheet.workspaceId,
    calendar: sheet.calendar,
    dependencies_enabled: sheet.dependenciesEnabled,
  })
  if (sheetRes.error) throw new Error(sheetRes.error.message)

  try {
    type Step = () => PromiseLike<{ error: { message: string } | null }>
    const steps: Step[] = [
      () => client.from('columns').insert(data.columns.map((c, i) => columnToDb(c, i, sheet))),
      () => client.from('rows').insert(data.rows.map((r) => rowToDb(r, sheet))),
    ]
    if (data.dependencies.length > 0) {
      steps.push(() =>
        client.from('dependencies').insert(data.dependencies.map((d) => dependencyToDb(d, sheet, crypto.randomUUID()))),
      )
    }
    for (const run of steps) {
      const res = await run()
      if (res.error) throw new Error(res.error.message)
    }
  } catch (err) {
    try {
      await client.from('sheets').delete().eq('id', sheet.id)
    } catch {
      // best-effort cleanup; report the original failure
    }
    throw err instanceof Error ? err : new Error('Could not save the schedule')
  }
  return sheet.id
}

/**
 * Plans the draft backward from its required date and saves it as a new sheet (sheet, columns,
 * rows, dependencies, in that order). Returns the new sheet's id. If anything after the sheet
 * fails, the sheet is deleted (best effort; its columns, rows and dependencies cascade) so no
 * half-built plan is left behind.
 */
export async function insertSheetFromDraft(
  client: SupabaseClient,
  draft: PlanDraft,
  userId: string,
  calendar: Calendar,
  options: { today?: string } = {},
): Promise<string> {
  const plan = planBackward(draft, calendar, options.today ?? todayIso())
  return insertSheetData(client, buildSheetFromDraft(draft, plan, userId, calendar))
}

/**
 * The batch variant: plans every draft backward to its own required date and saves ONE sheet with
 * all of them (see buildSheetFromDrafts), with the same cleanup on failure. Every draft is planned
 * before anything is written, so one that cannot be scheduled fails the call with nothing saved.
 */
export async function insertSheetFromDrafts(
  client: SupabaseClient,
  drafts: PlanDraft[],
  userId: string,
  calendar: Calendar,
  options: { today?: string; costCodes?: CostCodeColumn; project?: ProjectColumn } = {},
): Promise<string> {
  const today = options.today ?? todayIso()
  const items = drafts.map((draft) => ({ draft, plan: planBackward(draft, calendar, today) }))
  return insertSheetData(client, buildSheetFromDrafts(items, userId, calendar, options.costCodes, options.project))
}
