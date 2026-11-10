import { createStore, type StoreApi } from 'zustand/vanilla'
import { findCycle } from '../engine/cycles'
import { schedule, type SchedDep, type ScheduleResult } from '../engine/schedule'
import {
  deleteWithChildren,
  fullOrder,
  indent,
  moveRow as moveRowInTree,
  outdent,
  positionForNewRow,
  type RowNode,
} from '../model/hierarchy'
import { validateCell, type ColumnRole } from '../model/validate'
import type { Persistence, RowRecord, SheetData } from './persistence'
import { toSchedInput } from './scheduleInput'

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'failed'

export interface CellError {
  rowId: string
  colId: string
  message: string
}

export type ActionResult = { ok: true } | { ok: false; error: string }

export interface SheetState {
  data: SheetData | null
  scheduled: ScheduleResult
  saveStatus: SaveStatus
  /** Cell validation errors, at most one per cell. */
  errors: CellError[]
  notices: string[]
  loadError: string | null

  load(id: string): Promise<void>
  setCell(rowId: string, colId: string, raw: string): ActionResult
  addRow(afterId?: string | null, parentId?: string | null): string
  indentRow(id: string): void
  outdentRow(id: string): void
  moveRow(id: string, afterId: string | null, newParentId: string | null): void
  deleteRow(id: string): void
  addDependency(dep: SchedDep): ActionResult
  removeDependency(predecessorId: string, successorId: string): void
}

export interface SheetStoreOptions {
  /** Delay before each retry of a failed persistence call; its length is the retry count. */
  retryDelaysMs?: number[]
}

/** Columns whose values on a parent row come from its children. */
const ROLLUP_ROLES: readonly ColumnRole[] = ['start', 'end', 'duration', 'percentComplete']

const EMPTY_SCHEDULE: ScheduleResult = { byRow: {}, errors: [] }

function computeSchedule(data: SheetData): ScheduleResult {
  const input = toSchedInput(data)
  return input ? schedule(input.rows, input.deps, input.calendar) : EMPTY_SCHEDULE
}

const sameDep = (a: SchedDep, b: SchedDep) =>
  a.predecessorId === b.predecessorId && a.successorId === b.successorId && a.type === b.type && a.lagMinutes === b.lagMinutes

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * One queued persistence call. Jobs are keyed: a job whose key is already waiting in the
 * queue (not in flight) is merged into it, so the latest value wins. Keys:
 * - `cell:<row>:<col>`  one cell; `value` is the latest value to write
 * - `tree:<row>`        a row's place in the tree, or its insert while it is not yet persisted
 * - `deps`              the whole dependency set (replace-all); `value` is the latest set
 * - `delete`            pending row deletions (accumulated until one succeeds)
 * A key that ran out of retries stays in `failedKeys` until a later job with the same key
 * (or one that supersedes it, such as the row's insert) succeeds.
 */
interface Job {
  key: string
  value?: unknown
  run(job: Job): Promise<void>
}

/**
 * The sheet store: single in-memory source of truth. Edits apply optimistically and are
 * persisted in the background through one serial queue (which keeps per-cell saves in order
 * and a new row's insert ahead of edits to it). Failed calls are retried with the configured
 * delays; after that the status becomes `failed` and the optimistic state stays.
 *
 * Rows added in this session stay in `unpersisted` until an insert succeeds. Any later job
 * that touches such a row (cell edit, tree change, dependency save) inserts it first with its
 * current cells, parent and position instead of updating a row the database does not have.
 */
export function createSheetStore(p: Persistence, opts: SheetStoreOptions = {}): StoreApi<SheetState> {
  const retryDelays = opts.retryDelaysMs ?? [500, 1000, 2000]

  const queue: Job[] = []
  let current: Job | null = null
  let retrying = false
  const failedKeys = new Set<string>()
  /** Rows created locally whose insert has not succeeded yet. */
  const unpersisted = new Set<string>()
  /** Row ids to delete in the database; cleared when a delete succeeds. */
  const pendingDeletes = new Set<string>()

  const store = createStore<SheetState>()((set, get) => {
    function refreshStatus(): void {
      let status: SaveStatus
      if (failedKeys.size > 0) status = 'failed'
      else if (retrying) status = 'unsaved'
      else if (current || queue.length > 0) status = 'saving'
      else status = 'saved'
      if (get().saveStatus !== status) set({ saveStatus: status })
    }

    async function pump(): Promise<void> {
      while (queue.length > 0) {
        const job = queue.shift()!
        current = job
        refreshStatus()
        let ok = false
        for (let attempt = 0; ; attempt++) {
          try {
            await job.run(job)
            ok = true
            break
          } catch {
            if (attempt >= retryDelays.length) break
            retrying = true
            refreshStatus()
            await new Promise((r) => setTimeout(r, retryDelays[attempt]))
            retrying = false
            refreshStatus()
          }
        }
        if (ok) failedKeys.delete(job.key)
        else failedKeys.add(job.key)
        current = null
      }
      refreshStatus()
    }

    function enqueue(job: Job): void {
      failedKeys.delete(job.key)
      const pending = queue.find((j) => j.key === job.key)
      if (pending) pending.value = job.value
      else queue.push(job)
      if (current === null) void pump()
      else refreshStatus()
    }

    const findRow = (id: string) => get().data?.rows.find((r) => r.id === id)

    /** Insert a not-yet-persisted row with its current cells, parent and position. */
    async function insertNow(rowId: string): Promise<void> {
      const data = get().data
      const row = data?.rows.find((r) => r.id === rowId)
      if (!data || !row || !unpersisted.has(rowId)) return
      await p.insertRow(data.sheet.id, row)
      unpersisted.delete(rowId)
      // The insert carried the row's place and every cell's current value, so earlier failures
      // for them are resolved. A job still queued or in flight re-adds its key if it fails.
      for (const key of [...failedKeys]) {
        if (key === `tree:${rowId}` || key.startsWith(`cell:${rowId}:`)) failedKeys.delete(key)
      }
    }

    function enqueueCell(rowId: string, colId: string, value: unknown): void {
      enqueue({
        key: `cell:${rowId}:${colId}`,
        value,
        async run(job) {
          const row = findRow(rowId)
          if (!row) return // row deleted meanwhile; nothing to save
          if (unpersisted.has(rowId)) {
            await insertNow(rowId) // the insert carries this cell's current value
            return
          }
          const { version } = await p.saveCell(rowId, colId, job.value, row.version)
          const data = get().data
          if (!data) return
          set({ data: { ...data, rows: data.rows.map((r) => (r.id === rowId ? { ...r, version } : r)) } })
        },
      })
    }

    /** Persist a row's current place in the tree, inserting it first if it is not persisted. */
    function enqueueTree(rowId: string): void {
      enqueue({
        key: `tree:${rowId}`,
        async run() {
          const row = findRow(rowId)
          if (!row) return
          if (unpersisted.has(rowId)) {
            await insertNow(rowId)
            return
          }
          await p.saveRowTree([{ id: row.id, parentId: row.parentId, position: row.position }])
        },
      })
    }

    function enqueueDependencies(sheetId: string, deps: SchedDep[]): void {
      enqueue({
        key: 'deps',
        value: deps,
        async run(job) {
          const latest = job.value as SchedDep[]
          // A dependency on a row the database does not have would break the foreign key.
          const ids = new Set(latest.flatMap((d) => [d.predecessorId, d.successorId]))
          for (const id of ids) if (unpersisted.has(id)) await insertNow(id)
          await p.saveDependencies(sheetId, latest)
        },
      })
    }

    function enqueueDelete(ids: string[]): void {
      for (const id of ids) pendingDeletes.add(id)
      enqueue({
        key: 'delete',
        async run() {
          const batch = [...pendingDeletes]
          if (batch.length === 0) return
          await p.deleteRows(batch)
          for (const id of batch) pendingDeletes.delete(id)
        },
      })
    }

    /** Replace data and recompute the schedule. */
    function commit(data: SheetData, extra: Partial<SheetState> = {}): void {
      set({ data, scheduled: computeSchedule(data), ...extra })
    }

    /** Apply a hierarchy operation; a no-op (same array) does nothing at all. */
    function applyTree(op: (rows: RowNode[]) => RowNode[]): void {
      const data = get().data
      if (!data) return
      const next = op(data.rows)
      if (next === data.rows) return
      const before = new Map(data.rows.map((r) => [r.id, r]))
      const changed: string[] = []
      for (const r of next) {
        const old = before.get(r.id)
        if (!old || old.parentId !== r.parentId || old.position !== r.position) changed.push(r.id)
      }
      commit({ ...data, rows: next as RowRecord[] })
      for (const id of changed) enqueueTree(id)
    }

    const isParent = (data: SheetData, id: string) => data.rows.some((r) => r.parentId === id)

    function rowNumbers(data: SheetData): Map<string, number> {
      return new Map(fullOrder(data.rows).map((id, i) => [id, i + 1]))
    }

    return {
      data: null,
      scheduled: EMPTY_SCHEDULE,
      saveStatus: 'saved',
      errors: [],
      notices: [],
      loadError: null,

      async load(id) {
        set({ loadError: null })
        try {
          const data = await p.loadSheet(id)
          commit(data, { errors: [], notices: [], loadError: null })
        } catch (e) {
          set({ loadError: errorMessage(e) })
        }
      },

      setCell(rowId, colId, raw) {
        const data = get().data
        if (!data) return { ok: false, error: 'Sheet is not loaded' }
        const row = data.rows.find((r) => r.id === rowId)
        if (!row) return { ok: false, error: `Unknown row ${rowId}` }
        const col = data.columns.find((c) => c.id === colId)
        if (!col) return { ok: false, error: `Unknown column ${colId}` }
        if (col.role && ROLLUP_ROLES.includes(col.role) && isParent(data, rowId)) {
          return { ok: false, error: `${col.title} on a summary row is calculated from its child rows` }
        }

        const order = fullOrder(data.rows)
        const result = validateCell(col, raw, {
          rowCount: data.rows.length,
          ownRowNumber: order.indexOf(rowId) + 1,
          hoursPerDay: data.sheet.calendar.hoursPerDay,
          dependenciesEnabled: data.sheet.dependenciesEnabled,
        })
        const otherErrors = get().errors.filter((e) => !(e.rowId === rowId && e.colId === colId))
        if (!result.ok) {
          set({ errors: [...otherErrors, { rowId, colId, message: result.error }] })
          return { ok: false, error: result.error }
        }

        const rows = data.rows.map((r) => (r.id === rowId ? { ...r, cells: { ...r.cells, [colId]: result.value } } : r))
        commit({ ...data, rows }, { errors: otherErrors })
        enqueueCell(rowId, colId, result.value)
        return { ok: true }
      },

      addRow(afterId, parentId) {
        const data = get().data
        if (!data) throw new Error('Sheet is not loaded')
        const after = afterId ? data.rows.find((r) => r.id === afterId) : undefined
        const parent = parentId !== undefined ? parentId : (after?.parentId ?? null)
        // No afterId: append as the last child of the parent.
        let anchor: string | null = after ? after.id : null
        if (!after) {
          const siblings = fullOrder(data.rows).filter((id) => data.rows.find((r) => r.id === id)!.parentId === parent)
          anchor = siblings[siblings.length - 1] ?? null
        }
        const row: RowRecord = {
          id: crypto.randomUUID(),
          parentId: parent,
          position: positionForNewRow(data.rows, parent, anchor),
          cells: {},
          version: 0,
        }
        commit({ ...data, rows: [...data.rows, row] })
        unpersisted.add(row.id)
        enqueueTree(row.id) // inserts the row with its state when the job runs
        return row.id
      },

      indentRow(id) {
        applyTree((rows) => indent(rows, id))
      },

      outdentRow(id) {
        applyTree((rows) => outdent(rows, id))
      },

      moveRow(id, afterId, newParentId) {
        applyTree((rows) => moveRowInTree(rows, id, afterId, newParentId))
      },

      deleteRow(id) {
        const data = get().data
        if (!data) return
        const { rows, removedIds } = deleteWithChildren(data.rows, id)
        if (removedIds.length === 0) return
        const removed = new Set(removedIds)
        const deps = data.dependencies.filter((d) => !removed.has(d.predecessorId) && !removed.has(d.successorId))
        const droppedDeps = data.dependencies.length - deps.length
        const notices =
          droppedDeps > 0
            ? [
                ...get().notices,
                `Removed ${droppedDeps} ${droppedDeps === 1 ? 'dependency' : 'dependencies'} that referenced deleted rows`,
              ]
            : get().notices
        commit(
          { ...data, rows: rows as RowRecord[], dependencies: droppedDeps > 0 ? deps : data.dependencies },
          { notices, errors: get().errors.filter((e) => !removed.has(e.rowId)) },
        )
        for (const rid of removedIds) {
          unpersisted.delete(rid)
          for (const key of [...failedKeys]) {
            if (key === `tree:${rid}` || key.startsWith(`cell:${rid}:`)) failedKeys.delete(key)
          }
        }
        enqueueDelete(removedIds)
        if (droppedDeps > 0) enqueueDependencies(data.sheet.id, deps)
      },

      addDependency(dep) {
        const data = get().data
        if (!data) return { ok: false, error: 'Sheet is not loaded' }
        const ids = new Set(data.rows.map((r) => r.id))
        if (!ids.has(dep.predecessorId)) return { ok: false, error: `Unknown row ${dep.predecessorId}` }
        if (!ids.has(dep.successorId)) return { ok: false, error: `Unknown row ${dep.successorId}` }
        if (dep.predecessorId === dep.successorId) return { ok: false, error: 'A row cannot depend on itself' }
        if (data.dependencies.some((d) => sameDep(d, dep))) return { ok: false, error: 'That dependency already exists' }
        if (isParent(data, dep.successorId)) return { ok: false, error: 'Summary rows cannot have predecessors' }
        const deps = [...data.dependencies, dep]
        const cycle = findCycle(deps)
        if (cycle) {
          const nums = rowNumbers(data)
          const path = [...cycle, cycle[0]].map((id) => `row ${nums.get(id) ?? '?'}`).join(' -> ')
          return { ok: false, error: `Dependency would create a cycle: ${path}` }
        }
        commit({ ...data, dependencies: deps })
        enqueueDependencies(data.sheet.id, deps)
        return { ok: true }
      },

      removeDependency(predecessorId, successorId) {
        const data = get().data
        if (!data) return
        const deps = data.dependencies.filter((d) => !(d.predecessorId === predecessorId && d.successorId === successorId))
        if (deps.length === data.dependencies.length) return
        commit({ ...data, dependencies: deps })
        enqueueDependencies(data.sheet.id, deps)
      },
    }
  })

  return store
}
