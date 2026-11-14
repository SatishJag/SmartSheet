/** Builds a PlanDraft for a request: history, then the AI, then the history-only fallback. */
import { buildHistoryDraft } from '../src/planner/historyDraft'
import type { HistorySource, HistorySummary, PlanDraft, PlanRequest } from '../src/planner/types'
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
}

const FALLBACK_NOTES: Record<'unconfigured' | Exclude<AiOutcome, { ok: true }>['reason'], string> = {
  unconfigured: 'AI drafting is not configured on this server, so this draft is built from history only.',
  error: 'The AI drafting service was unavailable, so this draft is built from history only.',
  timeout: 'The AI drafting service took too long, so this draft is built from history only.',
  refused: 'The AI declined to draft this plan, so this draft is built from history only.',
  invalid: 'The AI draft failed validation twice, so this draft is built from history only.',
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

export async function createDraft(source: HistorySource, request: PlanRequest, config: PlannerConfig): Promise<PlanDraft> {
  const options = await source.options()
  const scheduleType = options.scheduleTypes.find((t) => t.id === request.scheduleType)
  if (!scheduleType) throw new PlannerError(400, `Unknown schedule type: ${request.scheduleType}.`)

  const catalog = await source.catalog(request.scheduleType)
  if (catalog.length === 0) throw new PlannerError(422, 'This schedule type has no activity catalog yet.')
  const { history, notes } = await selectHistory(source, request)

  const historyOnly = (why: string) => buildHistoryDraft({ request, catalog, history, assumptions: [why, ...notes] })
  let fallback: PlanDraft
  try {
    fallback = historyOnly(FALLBACK_NOTES.unconfigured) // also proves the catalog can make a valid plan
  } catch (err) {
    config.log('planner.catalog.invalid', { scheduleType: request.scheduleType, error: (err as Error).message })
    throw new PlannerError(500, 'The activity catalog for this schedule type is invalid.')
  }
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
  return {
    request,
    ...outcome.plan,
    assumptions: [...notes, ...outcome.plan.assumptions],
    source: 'ai',
    history,
  }
}
