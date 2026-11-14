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

/**
 * A draft in the shape the planning server returns for the LLE catalog: 14 activities ending in the
 * ONSITE milestone, with RAWMAT SS+5 after DWGAPP and MFG both FS after DWGAPP and SS+15 after
 * RAWMAT. `domestic` drops CUSTOMS (an optional activity) and links SHIP straight to DELIVER.
 */
export function catalogDraft(requiredDate = '2027-09-30', opts: { domestic?: boolean; overrides?: Partial<PlanDraft> } = {}): PlanDraft {
  const rows: [string, string, string, number, DraftActivity['basis']][] = [
    ['SPEC', 'Technical specification', 'Engineering', 10, 'p50'],
    ['RFQ', 'Request for quotation', 'Tendering', 15, 'p50'],
    ['BIDEVAL', 'Bid evaluation', 'Tendering', 10, 'p80'],
    ['AWARD', 'Purchase order award', 'Award', 5, 'p50'],
    ['DWGSUB', 'Vendor drawing submission', 'Engineering', 20, 'p80'],
    ['DWGAPP', 'Drawing approval', 'Engineering', 10, 'p50'],
    ['RAWMAT', 'Raw material procurement', 'Manufacturing', 30, 'p80'],
    ['MFG', 'Manufacturing', 'Manufacturing', 120, 'adjusted'],
    ['FAT', 'Factory acceptance test', 'Manufacturing', 5, 'p50'],
    ['RELEASE', 'Release for shipment', 'Logistics', 3, 'default'],
    ['SHIP', 'Shipping', 'Logistics', 30, 'p80'],
    ['CUSTOMS', 'Customs clearance', 'Logistics', 7, 'p50'],
    ['DELIVER', 'Delivery to site', 'Logistics', 5, 'p50'],
    ['ONSITE', 'On site', 'Logistics', 0, 'default'],
  ]
  const kept = rows.filter(([code]) => !(opts.domestic && code === 'CUSTOMS'))
  const activities = kept.map(([code, name, phase, days, basis]) =>
    activity(code, days, {
      name,
      phase,
      basis,
      reason:
        basis === 'adjusted'
          ? 'p80 is 110 days; raised 10 days because the vendor is at capacity.'
          : basis === 'default'
            ? 'No history; catalog default.'
            : `${basis} of 9 projects is ${days} days.`,
    }),
  )
  const chain = (codes: string[]) => codes.slice(1).map((c, i) => link(codes[i], c))
  const tail = ['MFG', 'FAT', 'RELEASE', 'SHIP', ...(opts.domestic ? [] : ['CUSTOMS']), 'DELIVER', 'ONSITE']
  const links: DraftLink[] = [
    ...chain(['SPEC', 'RFQ', 'BIDEVAL', 'AWARD', 'DWGSUB', 'DWGAPP']),
    link('DWGAPP', 'RAWMAT', 'SS', 5),
    link('DWGAPP', 'MFG'),
    link('RAWMAT', 'MFG', 'SS', 15),
    ...chain(tail),
  ]
  return makeDraft(activities, links, 'ONSITE', requiredDate, {
    summary: 'Procurement of a 400 MVA power transformer from specification to on-site delivery.',
    assumptions: ['Specification is ready to issue.', 'Two qualified vendors respond.'],
    risks: ['Manufacturing slots are scarce this year.', 'Port congestion can add a week to shipping.'],
    history: sampleHistory({
      stats: kept
        .filter(([, , , days]) => days > 0)
        .map(([code, , , days]) => ({ code, n: 9, p50: days, p80: Math.round(days * 1.2), min: Math.round(days * 0.7), max: Math.round(days * 1.5) })),
    }),
    ...opts.overrides,
  })
}
