import type { SupabaseClient } from '@supabase/supabase-js'
import type { SchedDep } from '../engine/schedule'
import type { Calendar, DepType } from '../engine/types'
import type { RowNode } from '../model/hierarchy'
import type { Column, ColumnRole, ColumnType } from '../model/validate'

export interface SheetMeta {
  id: string
  name: string
  ownerId: string
  workspaceId: string
  calendar: Calendar
  dependenciesEnabled: boolean
}

export type RowRecord = RowNode & { cells: Record<string, unknown>; version: number }

export interface SheetData {
  sheet: SheetMeta
  columns: Column[]
  rows: RowRecord[]
  dependencies: SchedDep[]
}

export interface Persistence {
  loadSheet(id: string): Promise<SheetData>
  saveCell(rowId: string, colId: string, value: unknown, version: number): Promise<{ version: number }>
  insertRow(sheetId: string, row: RowRecord): Promise<void>
  /** Only the rows whose parentId/position changed. */
  saveRowTree(rows: RowNode[]): Promise<void>
  /** Replace-all semantics for that sheet. */
  saveDependencies(sheetId: string, deps: SchedDep[]): Promise<void>
  deleteRows(ids: string[]): Promise<void>
}

// ---- DB row shapes (snake_case, as in supabase/migrations/0001_schema.sql) ----

export interface DbSheet {
  id: string
  name: string
  owner_id: string
  workspace_id: string
  calendar: Calendar
  dependencies_enabled: boolean
  created_at?: string
}

export interface DbColumn {
  id: string
  sheet_id: string
  owner_id?: string
  workspace_id?: string
  title: string
  type: string
  position: number
  options: string[] | null
  system_type: string | null
  role: string | null
  width: number | null
}

export interface DbRow {
  id: string
  sheet_id: string
  owner_id: string
  workspace_id: string
  parent_id: string | null
  position: string
  cells: Record<string, unknown> | null
  version: number
}

export interface DbDependency {
  id: string
  sheet_id: string
  owner_id: string
  workspace_id: string
  predecessor_row_id: string
  successor_row_id: string
  type: string
  lag_minutes: number
}

// ---- Pure mappers ----

export function sheetFromDb(r: DbSheet): SheetMeta {
  return {
    id: r.id,
    name: r.name,
    ownerId: r.owner_id,
    workspaceId: r.workspace_id,
    calendar: r.calendar,
    dependenciesEnabled: r.dependencies_enabled,
  }
}

export function columnFromDb(r: DbColumn): Column {
  const col: Column = { id: r.id, title: r.title, type: r.type as ColumnType }
  if (r.options != null) col.options = r.options
  if (r.system_type != null) col.systemType = r.system_type
  if (r.role != null) col.role = r.role as ColumnRole
  return col
}

export function columnToDb(
  col: Column,
  position: number,
  sheet: Pick<SheetMeta, 'id' | 'ownerId' | 'workspaceId'>,
): DbColumn {
  return {
    id: col.id,
    sheet_id: sheet.id,
    owner_id: sheet.ownerId,
    workspace_id: sheet.workspaceId,
    title: col.title,
    type: col.type,
    position,
    options: col.options ?? null,
    system_type: col.systemType ?? null,
    role: col.role ?? null,
    width: null,
  }
}

export function rowFromDb(r: DbRow): RowRecord {
  return { id: r.id, parentId: r.parent_id, position: r.position, cells: r.cells ?? {}, version: r.version }
}

export function rowToDb(row: RowRecord, sheet: Pick<SheetMeta, 'id' | 'ownerId' | 'workspaceId'>): DbRow {
  return {
    id: row.id,
    sheet_id: sheet.id,
    owner_id: sheet.ownerId,
    workspace_id: sheet.workspaceId,
    parent_id: row.parentId,
    position: row.position,
    cells: row.cells,
    version: row.version,
  }
}

export function dependencyFromDb(r: DbDependency): SchedDep {
  return {
    predecessorId: r.predecessor_row_id,
    successorId: r.successor_row_id,
    type: r.type as DepType,
    lagMinutes: r.lag_minutes,
  }
}

export function dependencyToDb(
  dep: SchedDep,
  sheet: Pick<SheetMeta, 'id' | 'ownerId' | 'workspaceId'>,
  id: string,
): DbDependency {
  return {
    id,
    sheet_id: sheet.id,
    owner_id: sheet.ownerId,
    workspace_id: sheet.workspaceId,
    predecessor_row_id: dep.predecessorId,
    successor_row_id: dep.successorId,
    type: dep.type,
    lag_minutes: dep.lagMinutes,
  }
}

// ---- Supabase implementation ----

/** Throws the Supabase error (if any) as an Error, otherwise returns the data. */
function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data
}

/**
 * Persistence backed by the Supabase tables `sheets`, `columns`, `rows` and `dependencies`.
 * Not exercised against a live Supabase in unit tests; only the mappers above are tested.
 */
export function supabasePersistence(client: SupabaseClient): Persistence {
  // owner_id / workspace_id of each sheet, needed when inserting child rows.
  const owners = new Map<string, Pick<SheetMeta, 'id' | 'ownerId' | 'workspaceId'>>()

  async function ownerOf(sheetId: string): Promise<Pick<SheetMeta, 'id' | 'ownerId' | 'workspaceId'>> {
    const cached = owners.get(sheetId)
    if (cached) return cached
    const r = check(
      await client.from('sheets').select('id, owner_id, workspace_id').eq('id', sheetId).single(),
    ) as Pick<DbSheet, 'id' | 'owner_id' | 'workspace_id'>
    const meta = { id: r.id, ownerId: r.owner_id, workspaceId: r.workspace_id }
    owners.set(sheetId, meta)
    return meta
  }

  return {
    async loadSheet(id) {
      const [sheetRes, colRes, rowRes, depRes] = await Promise.all([
        client.from('sheets').select('*').eq('id', id).single(),
        client.from('columns').select('*').eq('sheet_id', id).order('position', { ascending: true }),
        client.from('rows').select('*').eq('sheet_id', id),
        client.from('dependencies').select('*').eq('sheet_id', id),
      ])
      const sheet = sheetFromDb(check(sheetRes) as DbSheet)
      owners.set(sheet.id, sheet)
      return {
        sheet,
        columns: (check(colRes) as DbColumn[]).map(columnFromDb),
        rows: (check(rowRes) as DbRow[]).map(rowFromDb),
        dependencies: (check(depRes) as DbDependency[]).map(dependencyFromDb),
      }
    },

    /**
     * Read-modify-write of the row's `cells` JSON so other cells are not clobbered, bumping
     * `version`. This is NOT atomic: two clients writing different cells of the same row at
     * the same moment can lose one write. v1 is last-write-wins; the passed `_version` is
     * reserved for conflict detection later and is not checked.
     */
    async saveCell(rowId, colId, value, _version) {
      const current = check(
        await client.from('rows').select('cells, version').eq('id', rowId).single(),
      ) as Pick<DbRow, 'cells' | 'version'>
      const cells = { ...(current.cells ?? {}), [colId]: value }
      const updated = check(
        await client
          .from('rows')
          .update({ cells, version: current.version + 1 })
          .eq('id', rowId)
          .select('version')
          .single(),
      ) as Pick<DbRow, 'version'>
      return { version: updated.version }
    },

    async insertRow(sheetId, row) {
      const owner = await ownerOf(sheetId)
      check(await client.from('rows').insert(rowToDb(row, owner)))
    },

    async saveRowTree(rows) {
      const results = await Promise.all(
        rows.map((r) => client.from('rows').update({ parent_id: r.parentId, position: r.position }).eq('id', r.id)),
      )
      for (const res of results) check(res)
    },

    /** Insert the new set first, then delete the older rows, so a failed insert loses nothing. */
    async saveDependencies(sheetId, deps) {
      const owner = await ownerOf(sheetId)
      const fresh = deps.map((d) => dependencyToDb(d, owner, crypto.randomUUID()))
      if (fresh.length > 0) check(await client.from('dependencies').insert(fresh))
      let del = client.from('dependencies').delete().eq('sheet_id', sheetId)
      if (fresh.length > 0) del = del.not('id', 'in', `(${fresh.map((d) => d.id).join(',')})`)
      check(await del)
    },

    async deleteRows(ids) {
      if (ids.length === 0) return
      check(await client.from('rows').delete().in('id', ids))
    },
  }
}
