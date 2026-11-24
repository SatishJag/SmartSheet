import type { SupabaseClient } from '@supabase/supabase-js'
import type { DepType } from '../engine/types'
import type { ActivityStats, CatalogActivity, CostCode, HistorySource, HistorySummary, ItemLabels, PlannerOptions, Project, ProjectType, ScheduleType } from './types'

/**
 * The planner's history read from Supabase (supabase/migrations/0004_planner_history.sql).
 * The client should carry the user's token: the tables are readable by any signed-in user (RLS),
 * never by anon. Rows are snake_case; this maps them to the contract in ./types. Supabase errors
 * are thrown as `Error(message)`.
 */
const PROJECT_COLUMNS = 'code, name, is_program, project_type, in_procore'
/** Postgres: undefined_column. */
const UNDEFINED_COLUMN = '42703'

/** The projects offered to the planner: programmes first, then by code. */
const projectQuery = (client: SupabaseClient, columns: string) =>
  client.from('projects').select(columns).eq('in_planner', true).order('is_program', { ascending: false }).order('code', { ascending: true })

export function createSupabaseHistorySource(client: SupabaseClient): HistorySource {
  return {
    async options(): Promise<PlannerOptions> {
      const [types, equipment, projectTypeRows, codes, projectRows] = await Promise.all([
        // By position, so a project type opens on its main schedule type; name breaks ties.
        client.from('schedule_types').select('id, name, description, project_types, item_labels').order('position', { ascending: true }).order('name', { ascending: true }),
        client
          .from('planner_equipment_types')
          .select('schedule_type, equipment_type')
          .order('schedule_type', { ascending: true })
          .order('equipment_type', { ascending: true }),
        client.from('project_types').select('id, name, description').order('position', { ascending: true }),
        client.from('cost_codes').select('code, description, equipment_type').eq('in_planner', true).order('code', { ascending: true }),
        projectQuery(client, `${PROJECT_COLUMNS}, created_by`).then((r) =>
          // Before migration 0024 there is no created_by: still list the projects, just without "(new)".
          r.error && (r.error as { code?: string }).code === UNDEFINED_COLUMN ? projectQuery(client, PROJECT_COLUMNS) : r,
        ),
      ])
      const scheduleTypes = rows<ScheduleTypeRow>(types).map(
        (r): ScheduleType => ({
          id: r.id,
          name: r.name,
          description: r.description ?? '',
          ...(r.project_types?.length ? { projectTypes: r.project_types } : {}),
          ...(isItemLabels(r.item_labels) ? { itemLabels: r.item_labels } : {}),
        }),
      )
      const projectTypes = rows<ProjectTypeRow>(projectTypeRows).map(
        (r): ProjectType => ({ id: r.id, name: r.name, description: r.description ?? '' }),
      )
      const equipmentTypes: Record<string, string[]> = Object.fromEntries(scheduleTypes.map((t) => [t.id, []]))
      for (const r of rows<EquipmentRow>(equipment)) equipmentTypes[r.schedule_type]?.push(r.equipment_type)
      // Cost codes are optional: if they cannot be read, planning still works without them.
      const costCodes = codes.error
        ? []
        : ((codes.data ?? []) as CostCodeRow[]).map((r): CostCode => ({ code: r.code, description: r.description, equipmentType: r.equipment_type ?? null }))
      // Projects are optional too.
      const projects = projectRows.error
        ? []
        : ((projectRows.data ?? []) as unknown as ProjectRow[]).map(
            (r): Project => ({
              code: r.code,
              name: r.name,
              isProgram: r.is_program === true,
              projectType: r.project_type,
              inProcore: r.in_procore === true,
              ...(r.created_by ? { addedByPlanner: true } : {}),
            }),
          )
      return {
        ...(projectTypes.length ? { projectTypes } : {}),
        scheduleTypes,
        equipmentTypes,
        ...(costCodes.length ? { costCodes } : {}),
        ...(projects.length ? { projects } : {}),
      }
    },

    async catalog(scheduleType: string): Promise<CatalogActivity[]> {
      const result = await client
        .from('activity_catalog')
        .select('schedule_type, code, name, phase, sequence, default_links, default_days, is_target, activity_id, responsibility, criteria')
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
        ...(r.activity_id ? { activityId: r.activity_id } : {}),
        ...(r.responsibility ? { responsibility: r.responsibility } : {}),
        ...(r.criteria ? { criteria: r.criteria } : {}),
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
  project_types?: string[] | null
  item_labels?: unknown
}

const isItemLabels = (v: unknown): v is ItemLabels =>
  typeof v === 'object' &&
  v !== null &&
  ['noun', 'typeExample', 'nameExample'].every((k) => typeof (v as Record<string, unknown>)[k] === 'string' && (v as Record<string, string>)[k].trim() !== '')

interface ProjectTypeRow {
  id: string
  name: string
  description: string | null
}

interface EquipmentRow {
  schedule_type: string
  equipment_type: string
}

interface ProjectRow {
  code: string
  name: string
  is_program: boolean
  project_type: string
  in_procore: boolean
  /** Null for projects seeded by migrations. */
  created_by?: string | null
}

interface CostCodeRow {
  code: string
  description: string
  equipment_type: string | null
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
  activity_id?: string | null
  responsibility?: string | null
  criteria?: string | null
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
