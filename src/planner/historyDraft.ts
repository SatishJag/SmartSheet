/**
 * The deterministic draft the server returns when the AI is unavailable or keeps producing an
 * invalid plan: the catalog's standard sequence and default links, with the historical median
 * (p50) duration of each activity, or the catalog default where history has no data. Pure.
 */
import type { CatalogActivity, DraftActivity, HistorySummary, PlanDraft, PlanRequest } from './types'
import { isMilestone, validateDraft } from './validateDraft'

export interface HistoryDraftInput {
  request: PlanRequest
  catalog: CatalogActivity[]
  history: HistorySummary
  /** Shown first, e.g. why this is a history-only draft. */
  assumptions: string[]
}

export function buildHistoryDraft({ request, catalog, history, assumptions }: HistoryDraftInput): PlanDraft {
  const ordered = [...catalog].sort((a, b) => a.sequence - b.sequence)
  const codes = new Set(ordered.map((a) => a.code))
  const stats = new Map(history.stats.filter((s) => s.n > 0).map((s) => [s.code, s]))

  const activities: DraftActivity[] = ordered.map((a) => {
    const base = { code: a.code, name: a.name, phase: a.phase }
    const s = stats.get(a.code)
    if (isMilestone(a)) return { ...base, durationDays: 0, basis: 'default', reason: 'Milestone: takes no time.' }
    if (!s) {
      return { ...base, durationDays: a.defaultDays, basis: 'default', reason: `No history for this activity; catalog default of ${a.defaultDays} days.` }
    }
    const p50 = Math.round(s.p50)
    const projects = `${s.n} historical project${s.n === 1 ? '' : 's'}`
    if (p50 < 1) return { ...base, durationDays: 1, basis: 'adjusted', reason: `Median of ${projects} is under a day; rounded up to 1 day.` }
    return { ...base, durationDays: p50, basis: 'p50', reason: `Median (p50) of ${projects}.` }
  })

  const links = ordered.flatMap((a) =>
    a.defaultLinks.filter((l) => codes.has(l.from) && l.from !== a.code).map((l) => ({ from: l.from, to: a.code, type: l.type, lagDays: l.lagDays })),
  )

  const target = ordered.find((a) => a.isTarget)
  const proposal = {
    activities,
    links,
    targetCode: target?.code,
    summary: `Standard ${ordered.length}-step sequence for ${request.equipmentName}, with historical median durations.`,
    assumptions: [
      ...assumptions,
      'Durations are historical medians (p50); activities without history use the catalog default.',
      'The logic is the catalog standard sequence; review it for this equipment.',
    ],
    risks: ['Half of the historical projects took longer than the median for each activity; consider the p80 figures for critical items.'],
  }
  const checked = validateDraft(proposal, { catalog, stats: history.stats })
  if (!checked.ok) throw new Error(`The activity catalog does not produce a valid plan: ${checked.errors.join(' ')}`)
  return { request, ...checked.plan, source: 'history', history }
}
