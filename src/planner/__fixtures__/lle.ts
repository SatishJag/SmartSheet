/** Test fixtures: a small long-lead-equipment procurement catalog and its history. Tests only. */
import type { ActivityStats, CatalogActivity, HistorySummary, PlanRequest } from '../types'

const fs = (from: string) => [{ from, type: 'FS' as const, lagDays: 0 }]

function act(
  code: string,
  name: string,
  phase: string,
  sequence: number,
  defaultDays: number,
  defaultLinks: CatalogActivity['defaultLinks'],
  isTarget = false,
): CatalogActivity {
  return { scheduleType: 'lle-procurement', code, name, phase, sequence, defaultLinks, defaultDays, isTarget }
}

export const CATALOG: CatalogActivity[] = [
  act('SPEC', 'Technical specification', 'Engineering', 1, 10, []),
  act('RFQ', 'Request for quotation', 'Procurement', 2, 15, fs('SPEC')),
  act('PO', 'Purchase order award', 'Procurement', 3, 0, fs('RFQ')),
  act('DWG', 'Vendor drawings approval', 'Engineering', 4, 20, fs('PO')),
  act('FAB', 'Fabrication', 'Manufacturing', 5, 120, fs('DWG')),
  act('FAT', 'Factory acceptance test', 'Manufacturing', 6, 5, fs('FAB')),
  act('SHIP', 'Shipping', 'Logistics', 7, 30, fs('FAT')),
  act('SITE', 'On site', 'Logistics', 8, 0, fs('SHIP'), true),
]

function stat(code: string, n: number, p50: number, p80: number, min: number, max: number): ActivityStats {
  return { code, n, p50, p80, min, max }
}

export const STATS: ActivityStats[] = [
  stat('SPEC', 6, 12, 15, 8, 20),
  stat('RFQ', 6, 18.4, 25, 12, 30),
  stat('DWG', 6, 22, 30, 15, 40),
  stat('FAB', 6, 140, 170, 110, 200),
  stat('FAT', 5, 6, 8, 4, 10),
  stat('SHIP', 6, 35, 45, 25, 60),
]

export const HISTORY: HistorySummary = {
  scheduleType: 'lle-procurement',
  equipmentType: 'Power transformer',
  projectCount: 6,
  sampleOnly: true,
  stats: STATS,
}

export const REQUEST: PlanRequest = {
  scheduleType: 'lle-procurement',
  equipmentType: 'Power transformer',
  equipmentName: '400 MVA transformer for substation B',
  requiredDate: '2027-09-01',
}

const CODES = ['SPEC', 'RFQ', 'PO', 'DWG', 'FAB', 'FAT', 'SHIP', 'SITE']
const DURATIONS: Record<string, [number, string]> = {
  SPEC: [12, 'p50'],
  RFQ: [18, 'p50'],
  PO: [0, 'default'],
  DWG: [22, 'p50'],
  FAB: [170, 'p80'],
  FAT: [6, 'p50'],
  SHIP: [35, 'p50'],
  SITE: [0, 'default'],
}

/** A plan in the propose_plan tool-input shape that passes validateDraft against CATALOG and STATS. */
export function validProposal() {
  const byCode = new Map(CATALOG.map((a) => [a.code, a]))
  return {
    activities: CODES.map((code) => ({
      code,
      name: byCode.get(code)!.name,
      phase: byCode.get(code)!.phase,
      durationDays: DURATIONS[code][0],
      basis: DURATIONS[code][1],
      reason: `Uses the ${DURATIONS[code][1]} figure.`,
    })),
    links: CODES.slice(1).map((to, i) => ({ from: CODES[i], to, type: 'FS', lagDays: 0 })),
    targetCode: 'SITE',
    summary: 'Standard transformer procurement.',
    assumptions: ['Vendor already prequalified.'],
    risks: ['Fabrication slot availability.'],
  }
}
