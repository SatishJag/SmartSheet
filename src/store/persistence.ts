import type { SupabaseClient } from '@supabase/supabase-js'
import type { BaselineMeta, BaselineRow } from '../engine/baseline'
import type { SchedDep } from '../engine/schedule'
import type { Calendar, DepType } from '../engine/types'
import type { RowNode } from '../model/hierarchy'
import type { Column, ColumnRole, ColumnType } from '../model/validate'
import { fetchAllPages } from './paging'

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
  /** Baseline headers only (no rows), ordered by slot. Missing means none. */
  baselines?: BaselineMeta[]
}

export interface Persistence {
  loadSheet(id: string): Promise<SheetData>
  saveCell(rowId: string, colId: string, value: unknown, version: number): Promise<{ version: number }>
  insertRow(sheetId: string, row: RowRecord): Promise<void>
  /** Only the rows whose parentId/position changed. */
  saveRowTree(rows: RowNode[]): Promise<void>
  /** Replace-all semantics for that sheet (one dependency per predecessor/successor pair). */
  saveDependencies(sheetId: string, deps: SchedDep[]): Promise<void>
  deleteRows(ids: string[]): Promise<void>
  /** Writes the sheet's calendar and dependencies flag (the `sheets` row). */
  saveSheetSettings(sheetId: string, settings: SheetSettings): Promise<void>
  /** Adds a column at `position` (an upsert on id, so a retry after a lost response is safe). */
  insertColumn(sheetId: string, col: Column, position: number): Promise<void>
  /** Writes a column's title, type, options and role. */
  updateColumn(col: Column): Promise<void>
  /** Gives each column its index in `colIds` as its position (only changed positions need writing). */
  saveColumnOrder(sheetId: string, colIds: string[]): Promise<void>
  /** Deletes a column and removes its values from every row's cells, in one round trip. Idempotent. */
  deleteColumn(sheetId: string, colId: string): Promise<void>
  /** Sets one column's value on many rows (row id -> value); undefined or null empties the cell. */
  saveColumnCells(sheetId: string, colId: string, values: Record<string, unknown>): Promise<void>
  /** The saved rows of one baseline (loaded on demand: a sheet's baselines are not loaded with it). */
  loadBaselineRows(baselineId: string): Promise<BaselineRow[]>
  /** Saves a baseline into slot 1-5, replacing that slot's baseline, in one atomic call. Returns its header. */
  saveBaseline(sheetId: string, slot: number, name: string, rows: BaselineRow[]): Promise<BaselineMeta>
  /** Deletes a baseline and its rows. Idempotent. */
  deleteBaseline(baselineId: string): Promise<void>
}

/** The schedule settings of a sheet that users can change. */
export type SheetSettings = Pick<SheetMeta, 'calendar' | 'dependenciesEnabled'>

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
  /** Column formula (0007_column_formula.sql); absent in rows read before the migration was applied. */
  formula?: string | null
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

export interface DbBaseline {
  id: string
  sheet_id: string
  slot: number
  name: string
  created_at: string
}

/** A `baseline_rows` row; it has no `id`, so `id` mirrors `row_id` for paging. */
export interface DbBaselineRow {
  id: string
  baseline_id: string
  row_id: string
  start_date: string
  end_date: string
  duration_days: number
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
  if (r.formula != null) col.formula = r.formula
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
    // Only sent when set, so adding a column keeps working on a database without 0007_column_formula.sql.
    ...(col.formula ? { formula: col.formula } : {}),
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

export function baselineFromDb(r: Pick<DbBaseline, 'id' | 'slot' | 'name' | 'created_at'>): BaselineMeta {
  return { id: r.id, slot: r.slot, name: r.name, createdAt: r.created_at }
}

export function baselineRowFromDb(r: Pick<DbBaselineRow, 'row_id' | 'start_date' | 'end_date' | 'duration_days'>): BaselineRow {
  return { rowId: r.row_id, start: r.start_date, end: r.end_date, durationDays: r.duration_days }
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

/** The dependencies table's unique pair key (0002_hardening.sql), for upserts. */
const PAIR_CONFLICT = 'sheet_id,predecessor_row_id,successor_row_id'
const UPSERT_CHUNK = 500
const DELETE_CHUNK = 100

const pairKey = (d: Pick<SchedDep, 'predecessorId' | 'successorId'>) => `${d.predecessorId}>${d.successorId}`

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

  // The last dependency set known to be in the database, per sheet, keyed by pair.
  const persistedDeps = new Map<string, Map<string, { id: string; dep: SchedDep }>>()

  function indexDeps(rows: DbDependency[]): Map<string, { id: string; dep: SchedDep }> {
    const out = new Map<string, { id: string; dep: SchedDep }>()
    for (const r of rows) {
      const dep = dependencyFromDb(r)
      const k = pairKey(dep)
      if (!out.has(k)) out.set(k, { id: r.id, dep })
    }
    return out
  }

  const fetchDeps = (sheetId: string) =>
    fetchAllPages<DbDependency>((from, to) =>
      client.from('dependencies').select('*').eq('sheet_id', sheetId).order('id').range(from, to),
    )

  async function persistedDepsOf(sheetId: string) {
    let known = persistedDeps.get(sheetId)
    if (!known) {
      known = indexDeps(await fetchDeps(sheetId))
      persistedDeps.set(sheetId, known)
    }
    return known
  }

  return {
    /**
     * Supabase returns at most 1000 rows per request, so every list is paged with a stable
     * order; a failed or inconsistent page fails the whole load rather than truncating it.
     */
    async loadSheet(id) {
      const [sheetRes, cols, rows, deps, baselines] = await Promise.all([
        client.from('sheets').select('*').eq('id', id).single(),
        fetchAllPages<DbColumn>((from, to) =>
          client.from('columns').select('*').eq('sheet_id', id).order('position', { ascending: true }).order('id').range(from, to),
        ),
        fetchAllPages<DbRow>((from, to) => client.from('rows').select('*').eq('sheet_id', id).order('id').range(from, to)),
        fetchDeps(id),
        // Headers only: at most 5 per sheet, so no paging; their rows load on demand.
        client.from('baselines').select('id, slot, name, created_at').eq('sheet_id', id).order('slot', { ascending: true }),
      ])
      const sheet = sheetFromDb(check(sheetRes) as DbSheet)
      owners.set(sheet.id, sheet)
      // One dependency per pair (data written before 0002_hardening.sql may hold duplicates).
      const depIndex = indexDeps(deps)
      persistedDeps.set(sheet.id, depIndex)
      return {
        sheet,
        columns: cols.map(columnFromDb),
        rows: rows.map(rowFromDb),
        dependencies: [...depIndex.values()].map((d) => d.dep),
        baselines: (check(baselines) as Pick<DbBaseline, 'id' | 'slot' | 'name' | 'created_at'>[]).map(baselineFromDb),
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

    /** An upsert on id: retrying after a lost response must not fail with a duplicate key. */
    async insertRow(sheetId, row) {
      const owner = await ownerOf(sheetId)
      check(await client.from('rows').upsert(rowToDb(row, owner), { onConflict: 'id' }))
    },

    async saveRowTree(rows) {
      const results = await Promise.all(
        rows.map((r) => client.from('rows').update({ parent_id: r.parentId, position: r.position }).eq('id', r.id)),
      )
      for (const res of results) check(res)
    },

    /**
     * Diff-based: compares `deps` with the last persisted set of the sheet (by predecessor/successor
     * pair), upserts only new or changed pairs (ON CONFLICT on the pair key from
     * 0002_hardening.sql) and deletes only removed ones, by id, in chunks. Upserting first means a
     * failed delete loses nothing, and the unique pair key means it can never leave duplicates; a
     * retry repeats idempotent work. The in-memory persisted set is updated only after success.
     */
    async saveDependencies(sheetId, deps) {
      const owner = await ownerOf(sheetId)
      const known = await persistedDepsOf(sheetId)
      const desired = new Map(deps.map((d) => [pairKey(d), d]))
      const changed = [...desired].filter(([k, d]) => {
        const p = known.get(k)
        return !p || p.dep.type !== d.type || p.dep.lagMinutes !== d.lagMinutes
      })
      const removed = [...known].filter(([k]) => !desired.has(k))
      const next = new Map(known)

      for (let i = 0; i < changed.length; i += UPSERT_CHUNK) {
        const chunk = changed.slice(i, i + UPSERT_CHUNK)
        const written = check(
          await client
            .from('dependencies')
            .upsert(
              chunk.map(([, d]) => {
                const { id: _id, ...row } = dependencyToDb(d, owner, '')
                return row
              }),
              { onConflict: PAIR_CONFLICT },
            )
            .select('id, predecessor_row_id, successor_row_id'),
        ) as Pick<DbDependency, 'id' | 'predecessor_row_id' | 'successor_row_id'>[]
        for (const r of written) {
          const k = pairKey({ predecessorId: r.predecessor_row_id, successorId: r.successor_row_id })
          next.set(k, { id: r.id, dep: desired.get(k)! })
        }
      }
      for (let i = 0; i < removed.length; i += DELETE_CHUNK) {
        const chunk = removed.slice(i, i + DELETE_CHUNK)
        check(await client.from('dependencies').delete().in('id', chunk.map(([, p]) => p.id)))
        for (const [k] of chunk) next.delete(k)
      }
      persistedDeps.set(sheetId, next)
    },

    async deleteRows(ids) {
      if (ids.length === 0) return
      check(await client.from('rows').delete().in('id', ids))
    },

    async saveSheetSettings(sheetId, settings) {
      const updated = check(
        await client
          .from('sheets')
          .update({ calendar: settings.calendar, dependencies_enabled: settings.dependenciesEnabled })
          .eq('id', sheetId)
          .select('id'),
      ) as Pick<DbSheet, 'id'>[]
      // RLS hides other users' sheets, so a missing (deleted or foreign) sheet updates nothing.
      if (updated.length === 0) throw new Error(`Sheet ${sheetId} was not found`)
    },

    ...columnPersistence(client, ownerOf),
    ...baselinePersistence(client),
  }
}

type BaselineMethods = Pick<Persistence, 'loadBaselineRows' | 'saveBaseline' | 'deleteBaseline'>

/**
 * Baselines (0006_baselines.sql). Rows are paged like every other list (a baseline holds as many
 * rows as the sheet); saving is the atomic `save_baseline` function, one round trip.
 */
function baselinePersistence(client: SupabaseClient): BaselineMethods {
  return {
    async loadBaselineRows(baselineId) {
      // baseline_rows has no `id`; the paging helper needs one, so mirror the row id (its page order).
      const rows = await fetchAllPages<DbBaselineRow>(async (from, to) => {
        const res = await client
          .from('baseline_rows')
          .select('row_id, start_date, end_date, duration_days')
          .eq('baseline_id', baselineId)
          .order('row_id')
          .range(from, to)
        const data = res.data as Omit<DbBaselineRow, 'id' | 'baseline_id'>[] | null
        return { data: data ? data.map((r) => ({ ...r, id: r.row_id, baseline_id: baselineId })) : null, error: res.error }
      })
      return rows.map(baselineRowFromDb)
    },

    async saveBaseline(sheetId, slot, name, rows) {
      const id = check(
        await client.rpc('save_baseline', {
          p_sheet_id: sheetId,
          p_slot: slot,
          p_name: name,
          p_rows: rows.map((r) => ({ rowId: r.rowId, start: r.start, end: r.end, durationDays: r.durationDays })),
        }),
      ) as string | null
      if (!id) throw new Error('Saving the baseline returned no id')
      const header = check(
        await client.from('baselines').select('id, slot, name, created_at').eq('id', id).single(),
      ) as Pick<DbBaseline, 'id' | 'slot' | 'name' | 'created_at'>
      return baselineFromDb(header)
    },

    async deleteBaseline(baselineId) {
      // The rows go with it (on delete cascade).
      check(await client.from('baselines').delete().eq('id', baselineId))
    },
  }
}

/** Rows per `set_column_cells` call: keeps each request body small on a 5,000-row sheet. */
const COLUMN_CELLS_CHUNK = 1000

type ColumnMethods = Pick<Persistence, 'insertColumn' | 'updateColumn' | 'saveColumnOrder' | 'deleteColumn' | 'saveColumnCells'>

/**
 * Column management against the `columns` table and the database functions of 0003_columns.sql.
 * Deleting a column and rewriting one column's values are set-based (one call per 1,000 rows at
 * most) instead of a read-modify-write per row.
 */
function columnPersistence(
  client: SupabaseClient,
  ownerOf: (sheetId: string) => Promise<Pick<SheetMeta, 'id' | 'ownerId' | 'workspaceId'>>,
): ColumnMethods {
  return {
    async insertColumn(sheetId, col, position) {
      const owner = await ownerOf(sheetId)
      check(await client.from('columns').upsert(columnToDb(col, position, owner), { onConflict: 'id' }))
    },

    async updateColumn(col) {
      check(
        await client
          .from('columns')
          .update({ title: col.title, type: col.type, options: col.options ?? null, role: col.role ?? null, formula: col.formula ?? null })
          .eq('id', col.id),
      )
    },

    /** Reads the current positions first (a sheet has tens of columns), then updates only those that differ. */
    async saveColumnOrder(sheetId, colIds) {
      const current = check(await client.from('columns').select('id, position').eq('sheet_id', sheetId)) as Pick<DbColumn, 'id' | 'position'>[]
      const known = new Map(current.map((c) => [c.id, c.position]))
      const changed = colIds.map((id, position) => ({ id, position })).filter((c) => known.get(c.id) !== c.position)
      const results = await Promise.all(
        changed.map((c) => client.from('columns').update({ position: c.position }).eq('id', c.id)),
      )
      for (const res of results) check(res)
    },

    async deleteColumn(_sheetId, colId) {
      check(await client.rpc('delete_column', { p_column_id: colId }))
    },

    async saveColumnCells(sheetId, colId, values) {
      const entries = Object.entries(values)
      for (let i = 0; i < entries.length; i += COLUMN_CELLS_CHUNK) {
        const chunk = entries.slice(i, i + COLUMN_CELLS_CHUNK)
        const p_values = Object.fromEntries(chunk.map(([rowId, v]) => [rowId, v === undefined ? null : v]))
        check(await client.rpc('set_column_cells', { p_sheet_id: sheetId, p_column_id: colId, p_values }))
      }
    },
  }
}
