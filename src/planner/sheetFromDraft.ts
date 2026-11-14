import type { SupabaseClient } from '@supabase/supabase-js'
import { generateNKeysBetween } from 'fractional-indexing'
import { formatDuration } from '../engine/duration'
import type { SchedDep } from '../engine/schedule'
import type { Calendar } from '../engine/types'
import { MAX_SHEET_NAME_LENGTH } from '../auth/sheetName'
import type { Column } from '../model/validate'
import { columnToDb, dependencyToDb, rowToDb, type RowRecord, type SheetData } from '../store/persistence'
import { createSheetFromTemplate } from '../templates'
import { daysToMinutes, planBackward, todayIso, type BackwardPlan } from './backward'
import type { DraftActivity, HistorySummary, PlanDraft } from './types'

/** Title of the extra text column that says where each duration came from. */
export const BASIS_COLUMN_TITLE = 'Basis'

const NAME_PREFIX: Record<string, string> = { 'lle-procurement': 'LLE' }

/** "LLE – 400 MVA transformer" (at most the sheet-name limit). */
export function sheetNameForDraft(draft: PlanDraft): string {
  const prefix = NAME_PREFIX[draft.request.scheduleType] ?? 'Plan'
  const name = `${prefix} – ${draft.request.equipmentName.trim() || draft.request.equipmentType}`
  return name.length > MAX_SHEET_NAME_LENGTH ? `${name.slice(0, MAX_SHEET_NAME_LENGTH - 1)}…` : name
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

/**
 * The sheet a draft becomes: the Project schedule template's columns plus "Basis", one row per
 * activity in draft order, and one dependency per link. Only rows without predecessors carry a
 * Start (the backward-planned one); the engine derives every other date from the links, so the
 * sheet opens with the dates the preview showed. Pure apart from fresh ids.
 */
export function buildSheetFromDraft(draft: PlanDraft, plan: BackwardPlan, ownerId: string, calendar: Calendar): SheetData {
  const base = createSheetFromTemplate('project-schedule', ownerId)
  const sheet = {
    ...base.sheet,
    name: sheetNameForDraft(draft),
    calendar: { ...calendar, workingWeekdays: [...calendar.workingWeekdays], nonWorkingDates: [...calendar.nonWorkingDates] },
    dependenciesEnabled: true,
  }
  const basisColumn: Column = { id: crypto.randomUUID(), title: BASIS_COLUMN_TITLE, type: 'TEXT_NUMBER' }
  const columns = [...base.columns, basisColumn]
  const colId = (pick: (c: Column) => boolean, what: string) => {
    const col = columns.find(pick)
    if (!col) throw new Error(`The Project schedule template has no ${what} column`)
    return col.id
  }
  const taskCol = columns[0].id
  const phaseCol = colId((c) => c.title === 'Phase', 'Phase')
  const durationCol = colId((c) => c.role === 'duration', 'duration')
  const startCol = colId((c) => c.role === 'start', 'start')
  const statusCol = colId((c) => c.role === 'status', 'status')

  const planned = new Map(plan.activities.map((a) => [a.code, a]))
  const positions = generateNKeysBetween(null, null, draft.activities.length)
  const rowIdByCode = new Map<string, string>()
  const rows: RowRecord[] = draft.activities.map((a, i) => {
    const id = crypto.randomUUID()
    rowIdByCode.set(a.code, id)
    const p = planned.get(a.code)
    const cells: Record<string, unknown> = {
      [taskCol]: a.name,
      [phaseCol]: a.phase,
      [durationCol]: formatDuration({ minutes: daysToMinutes(a.durationDays, calendar), elapsed: false }, calendar.hoursPerDay),
      [statusCol]: 'Not started',
      [basisColumn.id]: basisText(a, draft.history),
    }
    if (p?.isRoot) cells[startCol] = p.start
    return { id, parentId: null, position: positions[i], cells, version: 0 }
  })

  const dependencies: SchedDep[] = plan.links.map((l) => ({
    predecessorId: rowIdByCode.get(l.from)!,
    successorId: rowIdByCode.get(l.to)!,
    type: l.type,
    lagMinutes: daysToMinutes(l.lagDays, calendar),
  }))

  return { sheet, columns, rows, dependencies }
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
  const data = buildSheetFromDraft(draft, plan, userId, calendar)
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
