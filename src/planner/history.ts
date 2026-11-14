import type { SupabaseClient } from '@supabase/supabase-js'
import type { DepType } from '../engine/types'
import type { ActivityStats, CatalogActivity, HistorySource, HistorySummary, PlannerOptions, ScheduleType } from './types'

/**
 * The planner's history read from Supabase (supabase/migrations/0004_planner_history.sql).
 * The client should carry the user's token: the tables are readable by any signed-in user (RLS),
 * never by anon. Rows are snake_case; this maps them to the contract in ./types. Supabase errors
 * are thrown as `Error(message)`.
 */
export function createSupabaseHistorySource(client: SupabaseClient): HistorySource {
  return {
    async options(): Promise<PlannerOptions> {
      const [types, equipment] = await Promise.all([
        client.from('schedule_types').select('id, name, description').order('name', { ascending: true }),
        client
          .from('planner_equipment_types')
          .select('schedule_type, equipment_type')
          .order('schedule_type', { ascending: true })
          .order('equipment_type', { ascending: true }),
      ])
      const scheduleTypes = rows<ScheduleTypeRow>(types).map(
        (r): ScheduleType => ({ id: r.id, name: r.name, description: r.description ?? '' }),
      )
      const equipmentTypes: Record<string, string[]> = Object.fromEntries(scheduleTypes.map((t) => [t.id, []]))
      for (const r of rows<EquipmentRow>(equipment)) equipmentTypes[r.schedule_type]?.push(r.equipment_type)
      return { scheduleTypes, equipmentTypes }
    },

    async catalog(scheduleType: string): Promise<CatalogActivity[]> {
      const result = await client
        .from('activity_catalog')
        .select('schedule_type, code, name, phase, sequence, default_links, default_days, is_target')
        .eq('schedule_type', scheduleType)
        .order('sequence', { ascending: true })
      return rows<CatalogRow>(result).map((r) => ({
        scheduleType: r.schedule_type,
        code: r.code,
        name: r.name,
        phase: r.phase,
        sequence: r.sequence,
        defaultLinks: toLinks(r.default_links, r.code),
        defaultDays: r.default_days,
        isTarget: r.is_target,
      }))
    },

    async summary(scheduleType: string, equipmentType: string | null): Promise<HistorySummary> {
      const { data, error } = await client.rpc('planner_history_summary', {
        p_schedule_type: scheduleType,
        p_equipment_type: equipmentType,
      })
      if (error) throw new Error(error.message)
      if (data === null || typeof data !== 'object') throw new Error(`No summary returned for ${scheduleType}`)
      const s = data as Partial<Record<keyof HistorySummary, unknown>>
      return {
        scheduleType: String(s.scheduleType ?? scheduleType),
        equipmentType: s.equipmentType == null ? null : String(s.equipmentType),
        projectCount: Number(s.projectCount ?? 0),
        sampleOnly: s.sampleOnly === true,
        stats: Array.isArray(s.stats) ? s.stats.map(toStats) : [],
      }
    },
  }
}

interface ScheduleTypeRow {
  id: string
  name: string
  description: string | null
}

interface EquipmentRow {
  schedule_type: string
  equipment_type: string
}

interface CatalogRow {
  schedule_type: string
  code: string
  name: string
  phase: string
  sequence: number
  default_links: unknown
  default_days: number
  is_target: boolean
}

/** The rows of a Supabase result, or its error thrown with Supabase's message. */
function rows<T>(result: { data: unknown; error: { message: string } | null }): T[] {
  if (result.error) throw new Error(result.error.message)
  return (result.data ?? []) as T[]
}

const DEP_TYPES: readonly string[] = ['FS', 'SS', 'FF', 'SF'] satisfies DepType[]

/** default_links JSON ([{from, type, lagDays}]) to typed links; a malformed entry is an error. */
function toLinks(json: unknown, code: string): CatalogActivity['defaultLinks'] {
  if (!Array.isArray(json)) throw new Error(`Catalog activity ${code}: default_links is not an array`)
  return json.map((l: { from?: unknown; type?: unknown; lagDays?: unknown } | null) => {
    const lag = Number(l?.lagDays ?? 0)
    if (typeof l?.from !== 'string' || typeof l.type !== 'string' || !DEP_TYPES.includes(l.type) || !Number.isFinite(lag)) {
      throw new Error(`Catalog activity ${code}: invalid default link ${JSON.stringify(l)}`)
    }
    return { from: l.from, type: l.type as DepType, lagDays: lag }
  })
}

function toStats(raw: Partial<Record<keyof ActivityStats, unknown>>): ActivityStats {
  return {
    code: String(raw.code),
    n: Number(raw.n),
    p50: Number(raw.p50),
    p80: Number(raw.p80),
    min: Number(raw.min),
    max: Number(raw.max),
  }
}
