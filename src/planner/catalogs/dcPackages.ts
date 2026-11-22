/**
 * The Data centre master's six long-lead packages: which long-lead history and cost code each uses, and
 * which history activities make up each of the template's nine steps.
 * (docs/superpowers/specs/2026-11-22-full-plan-design.md)
 */
import type { DcPackage } from './dcMaster'

export interface DcPackageInfo {
  /** history_projects.equipment_type of the package's history, or null when there is none. */
  equipmentType: string | null
  /** The cost code its rows carry, or null when none is set up yet. */
  costCode: string | null
}

export const DC_PACKAGES: Record<DcPackage, DcPackageInfo> = {
  Chillers: { equipmentType: 'Chiller', costCode: 'CHL' },
  'Generator Sets': { equipmentType: 'Diesel generator', costCode: 'GEN' },
  Transformers: { equipmentType: 'Power transformer', costCode: 'TRF' },
  Switchgear: { equipmentType: 'HV switchgear', costCode: 'HVS' },
  'Power Modules': { equipmentType: null, costCode: null },
  'Fan Wall Units (FWU)': { equipmentType: null, costCode: null },
}

/** The schedule type whose history the packages use. */
export const HISTORY_SCHEDULE_TYPE = 'lle-procurement'

/**
 * For each template step (1-7), the long-lead history activities whose p50s it sums. Step 8 (site
 * receipt and QA release) has no history counterpart and step 9 is a milestone: both keep the template.
 */
export const STEP_HISTORY_CODES: Record<number, string[]> = {
  1: ['SPEC'],
  2: ['RFQ', 'BIDEVAL'],
  3: ['AWARD'],
  4: ['DWGSUB', 'DWGAPP'],
  5: ['MFG'],
  6: ['FAT'],
  7: ['RELEASE', 'SHIP', 'CUSTOMS', 'DELIVER'],
}

/** The manufacture and FAT steps: FAT starts this many calendar days before manufacture finishes. */
export const MANUFACTURE_STEP = 5
export const FAT_STEP = 6
export const FAT_BEFORE_MANUFACTURE_END = 30
