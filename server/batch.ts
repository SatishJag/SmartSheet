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

export async function draftBatch(
  source: HistorySource,
  batch: BatchPlanRequest,
  config: PlannerConfig,
  concurrency = DEFAULT_BATCH_CONCURRENCY,
): Promise<BatchOutcome> {
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
      try {
        results[i] = { ok: true, draft: await createDraft(source, request, config) }
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
