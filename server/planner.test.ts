// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { dcMasterCatalog } from '../src/planner/catalogs/dcMasterCatalog'
import { CATALOG, HISTORY, REQUEST } from '../src/planner/__fixtures__/lle'
import type { HistorySource, HistorySummary } from '../src/planner/types'
import type { AnthropicLike } from './ai'
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

describe('createDraft: Data centre master', () => {
  const DC_REQUEST = { scheduleType: 'dc-master', equipmentType: 'Data centre', equipmentName: 'Bangkok 3', requiredDate: '2029-06-30' }
  const real = (equipmentType: string): HistorySummary => ({
    scheduleType: 'lle-procurement',
    equipmentType,
    projectCount: 9,
    sampleOnly: false,
    stats: ['SPEC', 'RFQ', 'BIDEVAL', 'AWARD', 'DWGSUB', 'DWGAPP', 'MFG', 'FAT', 'RELEASE', 'SHIP', 'CUSTOMS', 'DELIVER'].map((code) => ({ code, n: 9, p50: 5, p80: 8, min: 3, max: 9 })),
  })

  function dcSource(summary: HistorySource['summary']) {
    const s: HistorySource = {
      options: async () => ({ scheduleTypes: [{ id: 'dc-master', name: 'Data centre master schedule', description: '' }], equipmentTypes: {} }),
      catalog: vi.fn(async () => dcMasterCatalog()),
      summary: vi.fn(summary),
    }
    return s
  }

  const throwingAi = () => {
    const create = vi.fn(async () => {
      throw new Error('the AI must not be called')
    })
    return { client: { beta: { messages: { create } } } as unknown as AnthropicLike, create }
  }

  it('builds the Data centre master without the AI', async () => {
    const ai = throwingAi()
    const source = dcSource(async (_t, eq) => real(eq ?? 'all'))
    const draft = await createDraft(source, DC_REQUEST, { anthropic: ai.client, model: 'm', aiTimeoutMs: 1000, aiDeadlineMs: 1000, log: silentLogger })
    expect(draft.activities).toHaveLength(199)
    expect(draft.source).toBe('history')
    expect(ai.create).not.toHaveBeenCalled()
    expect(vi.mocked(source.summary).mock.calls.map((c) => c.join('|')).sort()).toEqual(
      ['lle-procurement|Chiller', 'lle-procurement|Diesel generator', 'lle-procurement|HV switchgear', 'lle-procurement|Power transformer'],
    )
    expect(draft.activities.find((a) => a.code === 'DC_0001')).toMatchObject({ activityId: 'DC-0001' })
  })

  it('keeps going when a package’s history cannot be read', async () => {
    const source = dcSource(async (_t, eq) => {
      if (eq === 'Chiller') throw new Error('rpc failed')
      return real(eq ?? 'all')
    })
    const draft = await createDraft(source, DC_REQUEST, { anthropic: null, model: 'm', aiTimeoutMs: 1000, aiDeadlineMs: 1000, log: silentLogger })
    expect(draft.activities).toHaveLength(199)
    expect(draft.assumptions).toContain('Chillers: template durations; the history for Chiller could not be read.')
  })
})
