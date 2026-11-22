/**
 * The Data centre master schedule's draft (docs/superpowers/specs/2026-11-22-full-plan-design.md): the
 * owner's template as it is, except that each long-lead package's steps take their duration from REAL
 * long-lead history where it exists, converted from working days to calendar days (the plan runs on a
 * 7-day week). No AI. Pure.
 */
import { DC_MASTER_ACTIVITIES, DC_MASTER_TYPE, type DcActivity, type DcPackage } from './catalogs/dcMaster'
import { DC_PACKAGES, FAT_BEFORE_MANUFACTURE_END, FAT_STEP, MANUFACTURE_STEP, STEP_HISTORY_CODES } from './catalogs/dcPackages'
import type { CatalogActivity, DraftActivity, DraftLink, HistorySummary, PlanDraft, PlanRequest } from './types'

/** Every day of the week is a working day on the Data centre master (0 = Sunday … 6 = Saturday). */
export const SEVEN_DAY_WEEK = [0, 1, 2, 3, 4, 5, 6]

export interface DcMasterDraftInput {
  request: PlanRequest
  /** The `dc-master` catalog (from activity_catalog). */
  catalog: CatalogActivity[]
  /** Long-lead history by equipment type; a missing key means no history was read. */
  histories: Record<string, HistorySummary>
  /** Equipment types whose history could not be read (the server says why in the assumptions). */
  unreadable?: string[]
}

/** Working days to calendar days on a 5-day week, rounded up. */
export const toCalendarDays = (workingDays: number) => Math.ceil((workingDays * 7) / 5)

const usable = (h: HistorySummary | undefined): h is HistorySummary => Boolean(h && !h.sampleOnly && h.projectCount > 0)

/** A step's calendar days from history, or null when the template must stand (no step codes, or a code without statistics). */
function stepFromHistory(step: number, history: HistorySummary): number | null {
  const codes = STEP_HISTORY_CODES[step]
  if (!codes) return null
  let working = 0
  for (const code of codes) {
    const s = history.stats.find((x) => x.code === code && x.n > 0)
    if (!s) return null
    working += s.p50
  }
  return toCalendarDays(working)
}

function packageNote(pkg: DcPackage, history: HistorySummary | undefined, unreadable: boolean): string {
  const type = DC_PACKAGES[pkg].equipmentType
  if (!type) return `${pkg}: template durations; no history yet.`
  if (unreadable) return `${pkg}: template durations; the history for ${type} could not be read.`
  if (!history || history.projectCount === 0) return `${pkg}: template durations; no history yet for ${type}.`
  if (history.sampleOnly) return `${pkg}: template durations; the history for ${type} is sample data only.`
  return `${pkg}: durations from ${history.projectCount} real project${history.projectCount === 1 ? '' : 's'} (${type}), converted to calendar days.`
}

export function buildDcMasterDraft({ request, catalog, histories, unreadable = [] }: DcMasterDraftInput): PlanDraft {
  const template = new Map<string, DcActivity>(DC_MASTER_ACTIVITIES.map((a) => [a.code, a]))
  const ordered = [...catalog].sort((a, b) => a.sequence - b.sequence)
  const packages = Object.keys(DC_PACKAGES) as DcPackage[]

  // The duration of every package activity whose history is real.
  const fromHistory = new Map<string, { days: number; reason: string }>()
  let projects = 0
  for (const pkg of packages) {
    const type = DC_PACKAGES[pkg].equipmentType
    const history = type ? histories[type] : undefined
    if (!usable(history)) continue
    projects += history.projectCount
    for (const a of DC_MASTER_ACTIVITIES) {
      if (a.package !== pkg || a.milestone || !a.step) continue
      const days = stepFromHistory(a.step, history)
      if (days !== null) fromHistory.set(a.code, { days, reason: `p50 of ${history.projectCount} project${history.projectCount === 1 ? '' : 's'} (${type}), in calendar days` })
    }
  }

  const activities: DraftActivity[] = ordered.map((c) => {
    const t = template.get(c.code)
    const costCode = t?.package ? DC_PACKAGES[t.package].costCode : null
    const base = {
      code: c.code,
      name: c.name,
      phase: c.phase,
      ...(c.activityId ? { activityId: c.activityId } : {}),
      ...(c.responsibility ? { responsibility: c.responsibility } : {}),
      ...(c.criteria ? { criteria: c.criteria } : {}),
      ...(costCode ? { costCode } : {}),
    }
    if (t?.milestone) return { ...base, durationDays: 0, basis: 'default' as const, reason: 'Milestone: takes no time.' }
    const h = fromHistory.get(c.code)
    if (h) return { ...base, durationDays: h.days, basis: 'history' as const, reason: h.reason }
    return { ...base, durationDays: c.defaultDays, basis: 'template' as const, reason: 'template' }
  })

  // The template's links; FAT keeps its place near the end of manufacture when manufacture comes from history.
  const durations = new Map(activities.map((a) => [a.code, a.durationDays]))
  const links: DraftLink[] = ordered.flatMap((c) =>
    c.defaultLinks.map((l) => {
      const to = template.get(c.code)
      const from = template.get(l.from)
      const fatOverlap = to?.package && to.step === FAT_STEP && from?.package === to.package && from.step === MANUFACTURE_STEP && l.type === 'SS' && fromHistory.has(l.from)
      const lagDays = fatOverlap ? Math.max(0, durations.get(l.from)! - FAT_BEFORE_MANUFACTURE_END) : l.lagDays
      return { from: l.from, to: c.code, type: l.type, lagDays }
    }),
  )

  const target = ordered.find((c) => c.isTarget)
  const history: HistorySummary = { scheduleType: DC_MASTER_TYPE.id, equipmentType: null, projectCount: projects, sampleOnly: false, stats: [] }
  return {
    request,
    activities,
    links,
    targetCode: target?.code ?? DC_MASTER_TYPE.targetCode,
    summary: `Data centre master schedule for ${request.equipmentName}: ${activities.length} activities from the template, long-lead packages from history where it is real.`,
    assumptions: [
      'Durations are the template’s calendar days on a 7-day week, planned back from the Ready for Service date.',
      ...packages.map((p) => {
        const type = DC_PACKAGES[p].equipmentType
        return packageNote(p, type ? histories[type] : undefined, Boolean(type && unreadable.includes(type)))
      }),
    ],
    risks: ['The long-lead packages drive the installation and commissioning dates; confirm supplier lead times before baselining.'],
    source: 'history',
    history,
  }
}
