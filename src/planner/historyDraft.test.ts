// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CATALOG, HISTORY, REQUEST } from './__fixtures__/lle'
import { buildHistoryDraft } from './historyDraft'
import { validateDraft } from './validateDraft'

describe('buildHistoryDraft', () => {
  const draft = buildHistoryDraft({ request: REQUEST, catalog: CATALOG, history: HISTORY, assumptions: ['AI unavailable.'] })

  it('follows the catalog sequence with its default links', () => {
    expect(draft.activities.map((a) => a.code)).toEqual(['SPEC', 'RFQ', 'PO', 'DWG', 'FAB', 'FAT', 'SHIP', 'SITE'])
    expect(draft.links).toContainEqual({ from: 'FAB', to: 'FAT', type: 'FS', lagDays: 0 })
    expect(draft.links).toHaveLength(7)
    expect(draft.targetCode).toBe('SITE')
  })

  it('uses rounded p50 where history exists and the catalog default elsewhere', () => {
    const byCode = Object.fromEntries(draft.activities.map((a) => [a.code, a]))
    expect(byCode.FAB).toMatchObject({ durationDays: 140, basis: 'p50' })
    expect(byCode.RFQ).toMatchObject({ durationDays: 18, basis: 'p50' })
    expect(byCode.FAB.reason).toMatch(/6 historical projects/)
    expect(byCode.PO).toMatchObject({ durationDays: 0, basis: 'default' })
  })

  it('is marked history, carries the request, the history and the given assumptions', () => {
    expect(draft.source).toBe('history')
    expect(draft.request).toEqual(REQUEST)
    expect(draft.history).toBe(HISTORY)
    expect(draft.assumptions[0]).toBe('AI unavailable.')
    expect(draft.summary).toMatch(/400 MVA transformer/)
  })

  it('passes validateDraft', () => {
    expect(validateDraft(draft, { catalog: CATALOG, stats: HISTORY.stats }).ok).toBe(true)
  })

  it('sorts by sequence even when the catalog arrives out of order', () => {
    const d = buildHistoryDraft({ request: REQUEST, catalog: [...CATALOG].reverse(), history: HISTORY, assumptions: [] })
    expect(d.activities[0].code).toBe('SPEC')
  })

  it('keeps durations positive when a tiny median rounds to 0', () => {
    const history = { ...HISTORY, stats: [{ code: 'FAT', n: 2, p50: 0.3, p80: 0.4, min: 0, max: 1 }] }
    const d = buildHistoryDraft({ request: REQUEST, catalog: CATALOG, history, assumptions: [] })
    const fat = d.activities.find((a) => a.code === 'FAT')!
    expect(fat).toMatchObject({ durationDays: 1, basis: 'adjusted' })
    expect(validateDraft(d, { catalog: CATALOG, stats: history.stats }).ok).toBe(true)
  })

  it('drops default links to codes the catalog does not have', () => {
    const catalog = CATALOG.map((a) => (a.code === 'SPEC' ? { ...a, defaultLinks: [{ from: 'GHOST', type: 'FS' as const, lagDays: 0 }] } : a))
    const d = buildHistoryDraft({ request: REQUEST, catalog, history: HISTORY, assumptions: [] })
    expect(d.links.some((l) => l.from === 'GHOST')).toBe(false)
  })

  it('throws when the catalog cannot produce a valid plan', () => {
    expect(() =>
      buildHistoryDraft({ request: REQUEST, catalog: CATALOG.map((a) => ({ ...a, isTarget: false })), history: HISTORY, assumptions: [] }),
    ).toThrow(/catalog/)
  })
})
