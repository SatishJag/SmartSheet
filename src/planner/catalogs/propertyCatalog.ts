import type { CatalogActivity } from '../types'
import { PROPERTY_DEVELOPMENT_ACTIVITIES as A, PROPERTY_DEVELOPMENT_TYPE as T } from './propertyDevelopment'

/** The template as the planner reads it from activity_catalog (0018_property_development.sql). */
export function propertyDevelopmentCatalog(): CatalogActivity[] {
  return A.map((a, i) => ({
    scheduleType: T.id,
    code: a.id,
    name: a.name,
    phase: a.stage,
    sequence: i + 1,
    defaultLinks: a.links.map((l) => ({ ...l })),
    defaultDays: a.defaultDays,
    isTarget: a.id === T.targetId,
    activityId: a.id,
    responsibility: a.responsibility,
    criteria: a.criteria,
  }))
}
