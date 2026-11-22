/**
 * Turns the copied rows of an imported plan, plus the server's durations and template links, into a
 * PlanDraft the usual preview and sheet builder take. The planner's activities, IDs, names, stages and
 * links are kept exactly; only blank durations and missing links are filled, and each says so.
 * (docs/superpowers/specs/2026-11-22-plan-import-design.md)
 */
import type { Calendar } from '../../engine/types'
import { planBackward, type BackwardPlan } from '../backward'
import type { DraftActivity, DraftLink, HistorySummary, ImportActivitiesResult, PlanDraft } from '../types'
import type { ImportedActivity } from './table'

/** request.scheduleType of a plan that matches no known schedule type (a general schedule). */
export const IMPORTED_SCHEDULE_TYPE = 'imported'
export const NO_LINKS_WARNING = 'No predecessors found: the dates are not meaningful until links are added.'

export interface ImportDraftInput {
  activities: ImportedActivity[]
  server: ImportActivitiesResult
  /** The confirmed schedule type, or null for a general schedule. */
  scheduleType: string | null
  /** Names the plan (and the sheet): the project's name, else the file name. */
  projectName: string
  /** The confirmed handover date: the target activity finishes on it. */
  requiredDate: string
  fileName: string
}

const FROM_FILE: Record<'file' | 'dates', string> = { file: 'from your file', dates: 'from your file’s dates' }

export function buildImportDraft(input: ImportDraftInput): { draft: PlanDraft; warnings: string[]; counts: { fromFile: number; filled: number } } {
  const { activities, server } = input
  const durations = new Map(server.durations.map((d) => [d.code, d]))
  const templateTargets = new Set(server.templateLinks.map((l) => l.to))
  const warnings: string[] = []

  const draftActivities: DraftActivity[] = activities.map((a) => {
    const base = {
      code: a.code,
      name: a.name,
      phase: a.phase,
      activityId: a.code,
      ...(a.responsibility ? { responsibility: a.responsibility } : {}),
      ...(a.criteria ? { criteria: a.criteria } : {}),
      status: a.status,
      ...(templateTargets.has(a.code) ? { linksFromTemplate: true } : {}),
    }
    if (a.durationDays !== null && a.durationFrom !== null) {
      return { ...base, durationDays: a.durationDays, basis: 'file', reason: FROM_FILE[a.durationFrom] }
    }
    const d = durations.get(a.code)
    if (!d) return { ...base, durationDays: a.milestone ? 0 : 1, basis: 'estimate', reason: 'default: no AI estimate available' }
    if (d.basis === 'history') return { ...base, durationDays: d.days, basis: 'p50', reason: d.reason }
    return { ...base, durationDays: d.days, basis: d.basis, reason: d.reason }
  })

  // The file's links. A schedule holds one link per pair: a second, different one is left out and named.
  const links: DraftLink[] = []
  const byPair = new Map<string, DraftLink>()
  for (const a of activities) {
    for (const l of a.links) {
      const key = `${l.from}>${a.code}`
      const kept = byPair.get(key)
      if (kept) {
        if (kept.type !== l.type || kept.lagDays !== l.lagDays) {
          warnings.push(`${a.code} has two links from ${l.from} (${kept.type} and ${l.type}); a schedule holds one link per pair, so only ${kept.type} is kept.`)
        }
        continue
      }
      const link = { from: l.from, to: a.code, type: l.type, lagDays: l.lagDays }
      byPair.set(key, link)
      links.push(link)
    }
  }

  // Template links, one at a time, skipping any that would close a loop with the links so far.
  const successors = new Map<string, string[]>()
  const addEdge = (from: string, to: string) => successors.set(from, [...(successors.get(from) ?? []), to])
  links.forEach((l) => addEdge(l.from, l.to))
  const reaches = (start: string, goal: string) => {
    const seen = new Set<string>()
    const stack = [start]
    while (stack.length > 0) {
      const at = stack.pop()!
      if (at === goal) return true
      if (seen.has(at)) continue
      seen.add(at)
      stack.push(...(successors.get(at) ?? []))
    }
    return false
  }
  const accepted = new Set<string>()
  for (const l of server.templateLinks) {
    if (byPair.has(`${l.from}>${l.to}`)) continue
    if (reaches(l.to, l.from)) {
      warnings.push(`The template link ${l.from} → ${l.to} is left out: it would make a loop with the links in your file.`)
      continue
    }
    const link = { from: l.from, to: l.to, type: l.type, lagDays: l.lagDays }
    byPair.set(`${l.from}>${l.to}`, link)
    links.push(link)
    addEdge(l.from, l.to)
    accepted.add(l.to)
  }
  for (const code of accepted) warnings.push(`${code} has no predecessors in the file; it uses the template’s links.`)
  for (const a of draftActivities) {
    if (a.linksFromTemplate && !accepted.has(a.code)) delete a.linksFromTemplate
  }
  const fallbacks = draftActivities.filter((a) => a.basis === 'estimate' && a.reason.startsWith('default:')).length
  if (fallbacks > 0) {
    warnings.push(`${fallbacks} duration${fallbacks === 1 ? '' : 's'} could not be estimated; ${fallbacks === 1 ? 'it is' : 'they are'} set to 5 days. Check them in Basis.`)
  }

  const hasPredecessor = new Set(links.map((l) => l.to))
  const hasSuccessor = new Set(links.map((l) => l.from))
  if (links.length === 0) warnings.push(NO_LINKS_WARNING)
  activities.slice(1).forEach((a) => {
    if (!hasPredecessor.has(a.code)) warnings.push(`${a.code} has no predecessors; it starts with the plan.`)
  })

  const codes = new Set(activities.map((a) => a.code))
  const sinks = activities.filter((a) => !hasSuccessor.has(a.code))
  const targetCode =
    server.targetCode && codes.has(server.targetCode) ? server.targetCode : sinks.length === 1 ? sinks[0].code : activities[activities.length - 1].code

  const scheduleType = input.scheduleType ?? IMPORTED_SCHEDULE_TYPE
  const history: HistorySummary = server.history ?? { scheduleType, equipmentType: null, projectCount: 0, sampleOnly: false, stats: [] }
  const fromFile = activities.filter((a) => a.durationDays !== null && a.durationFrom !== null).length

  return {
    draft: {
      request: { scheduleType, equipmentType: '', equipmentName: input.projectName, requiredDate: input.requiredDate },
      activities: draftActivities,
      links,
      targetCode,
      summary: `Imported from ${input.fileName}: ${activities.length} activities.`,
      assumptions: ['Activities, links and the durations given in the file are kept as they are; blank durations are filled and marked in Basis.'],
      risks: [],
      source: 'history',
      history,
    },
    warnings,
    counts: { fromFile, filled: activities.length - fromFile },
  }
}

/** The import planned backward from its handover date, or why it cannot be scheduled (e.g. a cycle). */
export function scheduleImport(draft: PlanDraft, cal: Calendar, today: string): { plan: BackwardPlan } | { error: string } {
  try {
    return { plan: planBackward(draft, cal, today) }
  } catch (err) {
    const message = (err as Error).message.replace(/^The draft cannot be scheduled: /, '')
    return { error: `The plan cannot be scheduled: ${message}` }
  }
}
