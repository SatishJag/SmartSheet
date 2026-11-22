/** Builds a PlanDraft for a request: history, then the AI, then the history-only fallback. */
import { DC_MASTER_TYPE } from '../src/planner/catalogs/dcMaster'
import { DC_PACKAGES, HISTORY_SCHEDULE_TYPE } from '../src/planner/catalogs/dcPackages'
import { buildDcMasterDraft } from '../src/planner/dcMasterDraft'
import { buildHistoryDraft } from '../src/planner/historyDraft'
import type { CatalogActivity, HistorySource, HistorySummary, PlanDraft, PlanRequest } from '../src/planner/types'
import { draftWithAi, type AiOutcome, type AnthropicLike } from './ai'
import type { Logger } from './log'

/** Fewer projects than this for one equipment type: use the whole schedule type's history. */
export const MIN_PROJECTS = 3

export class PlannerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface PlannerConfig {
  anthropic: AnthropicLike | null
  model: string
  aiTimeoutMs: number
  aiDeadlineMs: number
  log: Logger
  /** Aborted when the client disconnects: the AI call stops instead of running on unseen. */
  signal?: AbortSignal
  /** Draft from history only, without calling the AI, and say why (a batch that ran out of time). */
  skipAi?: 'batch-deadline'
}

const FALLBACK_NOTES: Record<'unconfigured' | 'batch-deadline' | Exclude<AiOutcome, { ok: true }>['reason'], string> = {
  unconfigured: 'AI drafting is not configured on this server, so this draft is built from history only.',
  error: 'The AI drafting service was unavailable, so this draft is built from history only.',
  timeout: 'The AI drafting service took too long, so this draft is built from history only.',
  refused: 'The AI declined to draft this plan, so this draft is built from history only.',
  invalid: 'The AI draft failed validation twice, so this draft is built from history only.',
  'batch-deadline': 'The time limit for a batch was reached before this item could be drafted by the AI, so it is built from history only.',
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The statistics to plan with, and what the planner should know about that choice. */
export async function selectHistory(source: HistorySource, request: PlanRequest): Promise<{ history: HistorySummary; notes: string[] }> {
  const own = await source.summary(request.scheduleType, request.equipmentType)
  const notes: string[] = []
  let history = own
  if (own.projectCount < MIN_PROJECTS) {
    const all = await source.summary(request.scheduleType, null)
    if (all.projectCount > own.projectCount) {
      history = all
      notes.push(
        `Only ${plural(own.projectCount, 'historical project')} for ${request.equipmentType}; durations use the statistics of all equipment types (${plural(all.projectCount, 'project')}).`,
      )
    } else if (own.projectCount > 0) {
      notes.push(`History is thin: ${plural(own.projectCount, 'project')} behind these durations.`)
    }
  }
  if (history.projectCount === 0) notes.push('There is no history for this schedule type yet; durations are catalog defaults.')
  if (history.sampleOnly && history.projectCount > 0) {
    notes.push('The history is SAMPLE data, not real projects: treat the durations as illustrative until real history is loaded.')
  }
  return { history, notes }
}

/**
 * The Data centre master (docs/superpowers/specs/2026-11-22-full-plan-design.md): the template plus each
 * package's long-lead history, without the AI. A package whose history cannot be read keeps the template.
 */
async function dcMasterDraft(source: HistorySource, request: PlanRequest, catalog: CatalogActivity[], config: PlannerConfig): Promise<PlanDraft> {
  const types = Object.values(DC_PACKAGES).flatMap((p) => (p.equipmentType ? [p.equipmentType] : []))
  const results = await Promise.allSettled(types.map((t) => source.summary(HISTORY_SCHEDULE_TYPE, t)))
  const histories: Record<string, HistorySummary> = {}
  const unreadable: string[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') histories[types[i]] = r.value
    else {
      unreadable.push(types[i])
      config.log('planner.dc-master.history-error', { equipmentType: types[i], error: (r.reason as Error)?.message })
    }
  })
  return withCatalogDetails(buildDcMasterDraft({ request, catalog, histories, unreadable }), catalog)
}

export async function createDraft(source: HistorySource, request: PlanRequest, config: PlannerConfig): Promise<PlanDraft> {
  const options = await source.options()
  const scheduleType = options.scheduleTypes.find((t) => t.id === request.scheduleType)
  if (!scheduleType) throw new PlannerError(400, `Unknown schedule type: ${request.scheduleType}.`)

  const catalog = await source.catalog(request.scheduleType)
  if (catalog.length === 0) throw new PlannerError(422, 'This schedule type has no activity catalog yet.')
  if (request.scheduleType === DC_MASTER_TYPE.id) return dcMasterDraft(source, request, catalog, config)
  const { history, notes } = await selectHistory(source, request)

  const historyOnly = (why: string) => withCatalogDetails(buildHistoryDraft({ request, catalog, history, assumptions: [why, ...notes] }), catalog)
  let fallback: PlanDraft
  try {
    fallback = historyOnly(FALLBACK_NOTES.unconfigured) // also proves the catalog can make a valid plan
  } catch (err) {
    config.log('planner.catalog.invalid', { scheduleType: request.scheduleType, error: (err as Error).message })
    throw new PlannerError(500, 'The activity catalog for this schedule type is invalid.')
  }
  if (config.skipAi) return historyOnly(FALLBACK_NOTES[config.skipAi])
  if (!config.anthropic) return fallback

  const outcome = await draftWithAi({
    client: config.anthropic,
    model: config.model,
    request,
    scheduleTypeName: scheduleType.name,
    catalog,
    history,
    timeoutMs: config.aiTimeoutMs,
    deadlineMs: config.aiDeadlineMs,
    log: config.log,
    signal: config.signal,
  })
  if (!outcome.ok) return historyOnly(FALLBACK_NOTES[outcome.reason])
  return withCatalogDetails(
    {
      request,
      ...outcome.plan,
      assumptions: [...notes, ...outcome.plan.assumptions],
      source: 'ai',
      history,
    },
    catalog,
  )
}

/** Copies the catalog's reference details (activity id, responsibility, criteria) onto the draft's activities. */
export function withCatalogDetails(draft: PlanDraft, catalog: CatalogActivity[]): PlanDraft {
  const byCode = new Map(catalog.map((a) => [a.code, a]))
  return {
    ...draft,
    activities: draft.activities.map((a) => {
      const c = byCode.get(a.code)
      return {
        ...a,
        ...(c?.activityId ? { activityId: c.activityId } : {}),
        ...(c?.responsibility ? { responsibility: c.responsibility } : {}),
        ...(c?.criteria ? { criteria: c.criteria } : {}),
      }
    }),
  }
}
