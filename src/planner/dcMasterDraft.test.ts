import { describe, expect, it } from 'vitest'
import { DC_MASTER_ACTIVITIES as A, type DcPackage } from './catalogs/dcMaster'
import { dcMasterCatalog } from './catalogs/dcMasterCatalog'
import { buildDcMasterDraft } from './dcMasterDraft'
import { basisText } from './sheetFromDraft'
import type { HistorySummary, PlanRequest } from './types'

const REQUEST: PlanRequest = { scheduleType: 'dc-master', equipmentType: 'Data centre', equipmentName: 'Bangkok 3', requiredDate: '2029-06-30' }

const P50: Record<string, number> = { SPEC: 10, RFQ: 15, BIDEVAL: 7, AWARD: 4, DWGSUB: 15, DWGAPP: 8, MFG: 60, FAT: 4, RELEASE: 4, SHIP: 20, CUSTOMS: 4, DELIVER: 4 }

function history(equipmentType: string, opts: { sampleOnly?: boolean; projectCount?: number; without?: string[] } = {}): HistorySummary {
  const n = opts.projectCount ?? 9
  return {
    scheduleType: 'lle-procurement',
    equipmentType,
    projectCount: n,
    sampleOnly: opts.sampleOnly ?? false,
    stats: Object.entries(P50)
      .filter(([code]) => !opts.without?.includes(code))
      .map(([code, p50]) => ({ code, n, p50, p80: p50 + 5, min: p50 - 2, max: p50 + 10 })),
  }
}

const build = (histories: Record<string, HistorySummary> = {}, unreadable: string[] = []) =>
  buildDcMasterDraft({ request: REQUEST, catalog: dcMasterCatalog(), histories, unreadable })

const steps = (p: DcPackage) => A.filter((a) => a.package === p)
const days = (draft: ReturnType<typeof build>, p: DcPackage) => steps(p).map((s) => draft.activities.find((a) => a.code === s.code)!.durationDays)
const template = (p: DcPackage) => steps(p).map((s) => s.defaultDays)

describe('buildDcMasterDraft', () => {
  it('keeps the template when the history is sample only', () => {
    const draft = build({ Chiller: history('Chiller', { sampleOnly: true }) })
    expect(days(draft, 'Chillers')).toEqual(template('Chillers'))
    const first = draft.activities.find((a) => a.code === steps('Chillers')[0].code)!
    expect(first).toMatchObject({ basis: 'template', reason: 'template' })
  })

  it('uses real history in calendar days', () => {
    const draft = build({ Chiller: history('Chiller') })
    expect(days(draft, 'Chillers')).toEqual([14, 31, 6, 33, 84, 6, 45, 7, 0])
    const first = draft.activities.find((a) => a.code === steps('Chillers')[0].code)!
    expect(first).toMatchObject({ basis: 'history', reason: 'p50 of 9 projects (Chiller), in calendar days' })
    expect(basisText(first, draft.history)).toBe('p50 of 9 projects (Chiller), in calendar days')
    // Step 8 has no history codes: template.
    expect(draft.activities.find((a) => a.code === steps('Chillers')[7].code)).toMatchObject({ basis: 'template', durationDays: 7 })
  })

  it('moves FAT with manufacture', () => {
    const [mfg, fat] = [steps('Chillers')[4].code, steps('Chillers')[5].code]
    const withHistory = build({ Chiller: history('Chiller') })
    expect(withHistory.links).toContainEqual({ from: mfg, to: fat, type: 'SS', lagDays: 54 })
    const withoutHistory = build()
    expect(withoutHistory.links).toContainEqual({ from: mfg, to: fat, type: 'SS', lagDays: 172 })
  })

  it('keeps the template when a step’s code has no statistics', () => {
    const draft = build({ Chiller: history('Chiller', { without: ['DELIVER'] }) })
    expect(days(draft, 'Chillers')).toEqual([14, 31, 6, 33, 84, 6, 74, 7, 0])
  })

  it('tags package activities with their cost codes', () => {
    const draft = build()
    const code = (p: DcPackage) => new Set(steps(p).map((s) => draft.activities.find((a) => a.code === s.code)!.costCode))
    expect(code('Chillers')).toEqual(new Set(['CHL']))
    expect(code('Generator Sets')).toEqual(new Set(['GEN']))
    expect(code('Transformers')).toEqual(new Set(['TRF']))
    expect(code('Switchgear')).toEqual(new Set(['HVS']))
    expect(code('Power Modules')).toEqual(new Set([undefined]))
    expect(code('Fan Wall Units (FWU)')).toEqual(new Set([undefined]))
    expect(draft.activities.filter((a) => a.costCode)).toHaveLength(36)
  })

  it('builds the whole template plan', () => {
    const draft = build()
    expect(draft.activities.map((a) => a.code)).toEqual(A.map((a) => a.code))
    expect(draft.links).toHaveLength(355)
    expect(draft).toMatchObject({ targetCode: 'DC_0192', source: 'history', request: REQUEST })
    const milestones = draft.activities.filter((a) => A.find((x) => x.code === a.code)!.milestone)
    expect(milestones.every((m) => m.durationDays === 0 && m.basis === 'default')).toBe(true)
    const others = draft.activities.filter((a) => !A.find((x) => x.code === a.code)!.milestone)
    expect(others.every((a) => a.basis === 'template' && a.durationDays === A.find((x) => x.code === a.code)!.defaultDays)).toBe(true)
    expect(draft.activities[0]).toMatchObject({ activityId: 'DC-0001', responsibility: A[0].responsibility, criteria: A[0].criteria, phase: A[0].stage })
  })

  it('says which packages use history in the assumptions', () => {
    const draft = build({ Chiller: history('Chiller', { sampleOnly: true }), 'Diesel generator': history('Diesel generator', { projectCount: 8 }), 'Power transformer': history('Power transformer', { projectCount: 0 }) }, ['HV switchgear'])
    expect(draft.assumptions).toEqual(
      expect.arrayContaining([
        'Chillers: template durations; the history for Chiller is sample data only.',
        'Generator Sets: durations from 8 real projects (Diesel generator), converted to calendar days.',
        'Transformers: template durations; no history yet for Power transformer.',
        'Switchgear: template durations; the history for HV switchgear could not be read.',
        'Power Modules: template durations; no history yet.',
        'Fan Wall Units (FWU): template durations; no history yet.',
      ]),
    )
    expect(draft.history).toMatchObject({ scheduleType: 'dc-master', equipmentType: null, projectCount: 8, sampleOnly: false, stats: [] })
  })
})
