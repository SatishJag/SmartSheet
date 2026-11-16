import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllPages } from '../store/paging'
import { supabasePersistence } from '../store/persistence'
import { taskFactsFromSheet } from './taskFacts'
import type { Allocation, AllocationKind, Assignment, Resource, ResourceKind, TaskFact, TimeOff } from './engine'

/** A sheet's schedulable tasks as the engine sees them, with the sheet's name for display. */
export interface SheetTasks {
  sheetId: string
  sheetName: string
  tasks: TaskFact[]
}

export interface ResourcePersistence {
  /** Every resource of the owner with its time off. */
  loadResources(): Promise<Resource[]>
  /** Creates or updates a resource and replaces its time off. */
  saveResource(resource: Resource): Promise<void>
  /** Deletes a resource; its time off and assignments go with it. */
  deleteResource(id: string): Promise<void>
  /** The assignments of one sheet, or of every sheet when `sheetId` is omitted. */
  loadAssignments(sheetId?: string): Promise<Assignment[]>
  /** Creates or updates an assignment (by id). */
  saveAssignment(a: Assignment): Promise<void>
  deleteAssignment(id: string): Promise<void>
  /** Loads a sheet and computes its tasks' dates and float. */
  loadSheetTasks(sheetId: string): Promise<SheetTasks>
}

// ---- DB row shapes (snake_case, as in supabase/migrations/0010_resources.sql) ----

export interface DbResource {
  id: string
  owner_id?: string
  workspace_id?: string
  name: string
  kind: string
  department: string | null
  skills: string[] | null
  cost_rate: number | string
  hours_by_weekday: (number | string)[]
}

export interface DbTimeOff {
  id: string
  resource_id: string
  owner_id?: string
  workspace_id?: string
  start_date: string
  end_date: string
  hours: number | string
  note: string | null
}

export interface DbAssignment {
  id: string
  sheet_id: string
  owner_id?: string
  workspace_id?: string
  row_id: string
  resource_id: string
  allocation_kind: string
  allocation_value: number | string
  start_date: string | null
  end_date: string | null
}

// ---- Pure mappers ----

export function resourceFromDb(r: DbResource, timeOff: DbTimeOff[] = []): Resource {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as ResourceKind,
    department: r.department,
    skills: r.skills ?? [],
    costRate: Number(r.cost_rate),
    hoursByWeekday: r.hours_by_weekday.map(Number),
    timeOff: timeOff
      .map((t): TimeOff => ({ start: t.start_date, end: t.end_date, hours: Number(t.hours), ...(t.note ? { note: t.note } : {}) }))
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)),
  }
}

export function resourceToDb(r: Resource): Omit<DbResource, 'owner_id' | 'workspace_id'> {
  return {
    id: r.id,
    name: r.name.trim(),
    kind: r.kind,
    department: r.department && r.department.trim() ? r.department.trim() : null,
    skills: r.skills,
    cost_rate: r.costRate,
    hours_by_weekday: r.hoursByWeekday,
  }
}

export function assignmentFromDb(r: DbAssignment): Assignment {
  return {
    id: r.id,
    sheetId: r.sheet_id,
    rowId: r.row_id,
    resourceId: r.resource_id,
    allocation: { kind: r.allocation_kind as AllocationKind, value: Number(r.allocation_value) } satisfies Allocation,
    startDate: r.start_date,
    endDate: r.end_date,
  }
}

export function assignmentToDb(a: Assignment): Omit<DbAssignment, 'owner_id' | 'workspace_id'> {
  return {
    id: a.id,
    sheet_id: a.sheetId,
    row_id: a.rowId,
    resource_id: a.resourceId,
    allocation_kind: a.allocation.kind,
    allocation_value: a.allocation.value,
    start_date: a.startDate,
    end_date: a.endDate,
  }
}

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data
}

/** Persistence backed by the Supabase tables of 0010_resources.sql (and `sheets` etc. to read tasks). */
export function supabaseResourcePersistence(client: SupabaseClient): ResourcePersistence {
  const sheets = supabasePersistence(client)
  return {
    async loadResources() {
      const [resources, timeOff] = await Promise.all([
        fetchAllPages<DbResource>((from, to) => client.from('resources').select('*').order('id').range(from, to)),
        fetchAllPages<DbTimeOff>((from, to) => client.from('resource_time_off').select('*').order('id').range(from, to)),
      ])
      const byResource = new Map<string, DbTimeOff[]>()
      for (const t of timeOff) (byResource.get(t.resource_id) ?? byResource.set(t.resource_id, []).get(t.resource_id)!).push(t)
      return resources.map((r) => resourceFromDb(r, byResource.get(r.id) ?? [])).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    },

    async saveResource(resource) {
      check(await client.from('resources').upsert(resourceToDb(resource), { onConflict: 'id' }))
      // Replace the time off: add the new rows first, then drop the old ones, so a failure never loses it.
      const old = check(await client.from('resource_time_off').select('id').eq('resource_id', resource.id)) as Pick<DbTimeOff, 'id'>[]
      if (resource.timeOff.length > 0) {
        check(
          await client.from('resource_time_off').insert(
            resource.timeOff.map((t) => ({
              id: crypto.randomUUID(),
              resource_id: resource.id,
              start_date: t.start,
              end_date: t.end,
              hours: t.hours,
              note: t.note ?? null,
            })),
          ),
        )
      }
      if (old.length > 0) {
        check(await client.from('resource_time_off').delete().in('id', old.map((o) => o.id)))
      }
    },

    async deleteResource(id) {
      check(await client.from('resources').delete().eq('id', id))
    },

    async loadAssignments(sheetId) {
      const rows = await fetchAllPages<DbAssignment>((from, to) => {
        const q = client.from('assignments').select('*')
        return (sheetId ? q.eq('sheet_id', sheetId) : q).order('id').range(from, to)
      })
      return rows.map(assignmentFromDb)
    },

    async saveAssignment(a) {
      check(await client.from('assignments').upsert(assignmentToDb(a), { onConflict: 'id' }))
    },

    async deleteAssignment(id) {
      check(await client.from('assignments').delete().eq('id', id))
    },

    async loadSheetTasks(sheetId) {
      const data = await sheets.loadSheet(sheetId)
      return { sheetId, sheetName: data.sheet.name, tasks: taskFactsFromSheet(data) }
    },
  }
}
