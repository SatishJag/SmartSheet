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
 * One queued persistence call. Cell saves share a key per cell so a newer value replaces a
 * queued one (latest wins); every other call has a unique key.
 */
interface Job {
  key: string
  /** For cell saves: the latest value to write. */
  value?: unknown
  run(job: Job): Promise<void>
}

/**
 * The sheet store: single in-memory source of truth. Edits apply optimistically and are
 * persisted in the background through one serial queue (which also keeps per-cell saves in
 * order and an inserted row ahead of edits to it). Failed calls are retried with the
 * configured delays; after that the status becomes `failed` and the optimistic state stays.
 */
export function createSheetStore(p: Persistence, opts: SheetStoreOptions = {}): StoreApi<SheetState> {
  const retryDelays = opts.retryDelaysMs ?? [500, 1000, 2000]

  const queue: Job[] = []
  let current: Job | null = null
  let retrying = false
  const failedKeys = new Set<string>()
  let opCounter = 0

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
        if (!ok) failedKeys.add(job.key)
        current = null
      }
      refreshStatus()
    }

    function enqueue(job: Job): void {
      failedKeys.delete(job.key)
      const pending = job.key.startsWith('cell:') ? queue.find((j) => j.key === job.key) : undefined
      if (pending) pending.value = job.value
      else queue.push(job)
      if (current === null) void pump()
      else refreshStatus()
    }

    function enqueueOp(run: () => Promise<void>): void {
      enqueue({ key: `op:${++opCounter}`, run: () => run() })
    }

    function enqueueCell(rowId: string, colId: string, value: unknown): void {
      enqueue({
        key: `cell:${rowId}:${colId}`,
        value,
        async run(job) {
          const row = get().data?.rows.find((r) => r.id === rowId)
          if (!row) return // row deleted meanwhile; nothing to save
          const { version } = await p.saveCell(rowId, colId, job.value, row.version)
          const data = get().data
          if (!data) return
          set({ data: { ...data, rows: data.rows.map((r) => (r.id === rowId ? { ...r, version } : r)) } })
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
      const changed: RowNode[] = []
      for (const r of next) {
        const old = before.get(r.id)
        if (!old || old.parentId !== r.parentId || old.position !== r.position) {
          changed.push({ id: r.id, parentId: r.parentId, position: r.position })
        }
      }
      commit({ ...data, rows: next as RowRecord[] })
      if (changed.length > 0) enqueueOp(() => p.saveRowTree(changed))
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
        enqueueOp(() => p.insertRow(data.sheet.id, row))
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
        enqueueOp(() => p.deleteRows(removedIds))
        if (droppedDeps > 0) enqueueOp(() => p.saveDependencies(data.sheet.id, deps))
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
        enqueueOp(() => p.saveDependencies(data.sheet.id, deps))
        return { ok: true }
      },

      removeDependency(predecessorId, successorId) {
        const data = get().data
        if (!data) return
        const deps = data.dependencies.filter((d) => !(d.predecessorId === predecessorId && d.successorId === successorId))
        if (deps.length === data.dependencies.length) return
        commit({ ...data, dependencies: deps })
        enqueueOp(() => p.saveDependencies(data.sheet.id, deps))
      },
    }
  })

  return store
}
