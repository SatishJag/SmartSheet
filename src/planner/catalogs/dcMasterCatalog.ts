import type { CatalogActivity } from '../types'
import { DC_MASTER_ACTIVITIES as A, DC_MASTER_TYPE as T } from './dcMaster'

/** The Data centre master as the planner reads it from activity_catalog (0023_dc_master.sql). */
export function dcMasterCatalog(): CatalogActivity[] {
  return A.map((a, i) => ({
    scheduleType: T.id,
    code: a.code,
    name: a.name,
    phase: a.stage,
    sequence: i + 1,
    defaultLinks: a.links.map((l) => ({ ...l })),
    defaultDays: a.defaultDays,
    isTarget: a.code === T.targetCode,
    activityId: a.id,
    responsibility: a.responsibility,
    criteria: a.criteria,
  }))
}
