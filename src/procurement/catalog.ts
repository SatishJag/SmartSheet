import { EQUIPMENT_TYPES } from './equipment'
import { STARTER_TYPES } from './starters'
import type { ProcurementType } from './types'

/** Every schedule type the planner can draft: the eight long-lead equipment types, then materials, subcontract and consultant. */
export const PROCUREMENT_TYPES: readonly ProcurementType[] = [...EQUIPMENT_TYPES, ...STARTER_TYPES]

export const procurementType = (code: string): ProcurementType | undefined => PROCUREMENT_TYPES.find((t) => t.code === code)
