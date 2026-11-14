// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CATALOG, HISTORY, REQUEST } from '../src/planner/__fixtures__/lle'
import type { HistorySource, HistorySummary } from '../src/planner/types'
import { silentLogger } from './log'
import { createDraft, selectHistory } from './planner'

const EMPTY: HistorySummary = { scheduleType: 'lle-procurement', equipmentType: 'Power transformer', projectCount: 0, sampleOnly: false, stats: [] }

function source(own: HistorySummary, all: HistorySummary): HistorySource {
  return {
    options: async () => ({ scheduleTypes: [{ id: 'lle-procurement', name: 'LLE', description: '' }], equipmentTypes: {} }),
    catalog: async () => CATALOG,
    summary: async (_t, eq) => (eq === null ? all : own),
  }
}

describe('selectHistory', () => {
  it('keeps the equipment history when it has at least 3 projects', async () => {
    const { history, notes } = await selectHistory(source(HISTORY, { ...HISTORY, equipmentType: null }), REQUEST)
    expect(history).toBe(HISTORY)
    expect(notes).toEqual([expect.stringMatching(/SAMPLE/)])
  })

  it('says when there is no history at all and does not call empty history sample data', async () => {
    const { history, notes } = await selectHistory(source(EMPTY, { ...EMPTY, equipmentType: null }), REQUEST)
    expect(history).toBe(EMPTY)
    expect(notes).toEqual([expect.stringMatching(/no history/)])
  })

  it('keeps thin equipment history when the whole type has no more', async () => {
    const thin = { ...HISTORY, projectCount: 2, sampleOnly: false }
    const { history, notes } = await selectHistory(source(thin, { ...thin, equipmentType: null }), REQUEST)
    expect(history).toBe(thin)
    expect(notes).toEqual([expect.stringMatching(/thin: 2 projects/)])
  })
})

describe('createDraft', () => {
  it('builds a valid history-only draft from catalog defaults when there is no history', async () => {
    const config = { anthropic: null, model: 'm', aiTimeoutMs: 1, aiDeadlineMs: 1, log: silentLogger }
    const draft = await createDraft(source(EMPTY, { ...EMPTY, equipmentType: null }), REQUEST, config)
    expect(draft.source).toBe('history')
    expect(draft.activities.every((a) => a.basis === 'default')).toBe(true)
    expect(draft.activities.find((a) => a.code === 'FAB')?.durationDays).toBe(120)
  })
})
