import type { DraftActivity, DraftLink, HistorySummary, PlanDraft } from '../planner/types'

/** Test helpers: small drafts in the contract's shape. Not used by the app. */

export function activity(code: string, durationDays: number, extra: Partial<DraftActivity> = {}): DraftActivity {
  return {
    code,
    name: extra.name ?? `Activity ${code}`,
    phase: extra.phase ?? 'Procurement',
    durationDays,
    basis: extra.basis ?? 'p50',
    reason: extra.reason ?? `p50 of history for ${code}`,
    ...extra,
  }
}

export const link = (from: string, to: string, type: DraftLink['type'] = 'FS', lagDays = 0): DraftLink => ({ from, to, type, lagDays })

export const sampleHistory = (overrides: Partial<HistorySummary> = {}): HistorySummary => ({
  scheduleType: 'lle-procurement',
  equipmentType: 'Power transformer',
  projectCount: 9,
  sampleOnly: false,
  stats: [],
  ...overrides,
})

export function makeDraft(
  activities: DraftActivity[],
  links: DraftLink[],
  targetCode: string,
  requiredDate: string,
  overrides: Partial<PlanDraft> = {},
): PlanDraft {
  return {
    request: {
      scheduleType: 'lle-procurement',
      equipmentType: 'Power transformer',
      equipmentName: '400 MVA transformer',
      requiredDate,
    },
    activities,
    links,
    targetCode,
    summary: 'A first-cut procurement plan.',
    assumptions: [],
    risks: [],
    source: 'ai',
    history: sampleHistory(),
    ...overrides,
  }
}

/**
 * A realistic long-lead procurement draft (8 activities, FS/SS/FF links, a lag, a lead and a
 * milestone target) with history statistics for the Basis column.
 */
export function lleDraft(requiredDate = '2027-06-30', overrides: Partial<PlanDraft> = {}): PlanDraft {
  const activities: DraftActivity[] = [
    activity('SPEC', 10, { name: 'Technical specification', phase: 'Engineering', basis: 'p80', reason: 'p80 of 9 projects is 10 days.' }),
    activity('RFQ', 15, { name: 'Request for quotation', phase: 'Tendering', basis: 'p50', reason: 'p50 of 9 projects is 15 days.' }),
    activity('EVAL', 10, { name: 'Bid evaluation', phase: 'Tendering', basis: 'p80', reason: 'p80 of 8 projects is 10 days.' }),
    activity('PO', 5, { name: 'Purchase order award', phase: 'Award', basis: 'default', reason: 'No history; catalog default.' }),
    activity('DWG', 20, { name: 'Vendor drawings approval', phase: 'Engineering', basis: 'p80', reason: 'p80 of 9 projects is 20 days.' }),
    activity('FAB', 120, { name: 'Fabrication', phase: 'Manufacturing', basis: 'adjusted', reason: 'Raised from p80 110 days for the requested conservatism.' }),
    activity('SHIP', 25, { name: 'Shipping', phase: 'Logistics', basis: 'p50', reason: 'p50 of 7 projects is 25 days.' }),
    activity('ONSITE', 0, { name: 'Delivered to site', phase: 'Logistics', basis: 'default', reason: 'Milestone.' }),
  ]
  const links: DraftLink[] = [
    link('SPEC', 'RFQ'),
    link('RFQ', 'EVAL'),
    link('EVAL', 'PO', 'FS', 2),
    link('PO', 'DWG'),
    link('DWG', 'FAB', 'SS', 10),
    link('FAB', 'SHIP', 'FS', -2),
    link('SHIP', 'ONSITE'),
  ]
  return makeDraft(activities, links, 'ONSITE', requiredDate, {
    summary: 'Procurement of a 400 MVA transformer, drafted from 9 historical projects.',
    assumptions: ['Vendor shortlist exists.'],
    risks: ['Fabrication slots are scarce.'],
    history: sampleHistory({
      stats: [
        { code: 'SPEC', n: 9, p50: 8, p80: 10, min: 5, max: 14 },
        { code: 'RFQ', n: 9, p50: 15, p80: 18, min: 10, max: 25 },
        { code: 'EVAL', n: 8, p50: 8, p80: 10, min: 5, max: 12 },
        { code: 'DWG', n: 9, p50: 15, p80: 20, min: 10, max: 30 },
        { code: 'FAB', n: 9, p50: 95, p80: 110, min: 80, max: 140 },
        { code: 'SHIP', n: 7, p50: 25, p80: 30, min: 15, max: 40 },
      ],
    }),
    ...overrides,
  })
}
