/**
 * Drafts several equipment items for one request, a few at a time. Each item is an ordinary
 * `createDraft`; one item failing does not lose the others.
 */
import type { BatchItemResult, BatchPlanRequest, HistorySource } from '../src/planner/types'
import { createDraft, PlannerError, type PlannerConfig } from './planner'
import { planRequestFor } from './request'

export interface BatchOutcome {
  /** results[i] belongs to items[i]; null for an item never started because the signal aborted first. */
  results: (BatchItemResult | null)[]
  /** How many items were started (the rest were skipped after an abort). */
  started: number
}

/** Items drafted at the same time unless the caller says otherwise. */
export const DEFAULT_BATCH_CONCURRENCY = 2

/**
 * Time allowed for a whole batch. Each item has its own AI limit, but six items two at a time are
 * three rounds, which could outlast a web proxy's request limit. Past this limit, items not yet
 * started are drafted from history alone, and items in flight get only the time that is left.
 */
export const DEFAULT_BATCH_DEADLINE_MS = 210_000

/** Below this much time left (or half the batch limit, if that is smaller), an item is not worth an AI call. */
const MIN_AI_WINDOW_MS = 5_000

export async function draftBatch(
  source: HistorySource,
  batch: BatchPlanRequest,
  config: PlannerConfig,
  concurrency = DEFAULT_BATCH_CONCURRENCY,
  deadlineMs = DEFAULT_BATCH_DEADLINE_MS,
): Promise<BatchOutcome> {
  const endsAt = Date.now() + deadlineMs
  const minWindow = Math.min(MIN_AI_WINDOW_MS, deadlineMs / 2)
  const results: (BatchItemResult | null)[] = batch.items.map(() => null)
  let next = 0
  let started = 0

  async function worker() {
    for (;;) {
      if (config.signal?.aborted) return
      const i = next++
      if (i >= batch.items.length) return
      started++
      const request = planRequestFor(batch, batch.items[i])
      const left = endsAt - Date.now()
      const itemConfig: PlannerConfig =
        left < minWindow
          ? { ...config, skipAi: 'batch-deadline' }
          : { ...config, aiDeadlineMs: Math.min(config.aiDeadlineMs, left), aiTimeoutMs: Math.min(config.aiTimeoutMs, left) }
      try {
        results[i] = { ok: true, draft: await createDraft(source, request, itemConfig) }
      } catch (err) {
        if (err instanceof PlannerError) {
          results[i] = { ok: false, error: err.message }
        } else {
          config.log('planner.batch.item.error', { index: i, error: (err as Error).message })
          results[i] = { ok: false, error: 'Could not read the planner history.' }
        }
      }
    }
  }

  const workers = Math.max(1, Math.min(Math.floor(concurrency), batch.items.length))
  await Promise.all(Array.from({ length: workers }, worker))
  return { results, started }
}
