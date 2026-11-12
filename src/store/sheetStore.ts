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
import { parsePredecessorInput, rowNumbers } from './predecessors'
import { toSchedInput } from './scheduleInput'
import { normalizeCalendar, sameCalendar, scheduleFormulaProblem } from './sheetSettings'
import type { Calendar } from '../engine/types'

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
  /** How many changes (cells, row places, the dependency set, deletions) failed to save. */
  failedCount: number
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
  /**
   * Replace all of the row's incoming dependencies with those described by `raw` (e.g.
   * "2FS +1d, 5SS"; '' removes them). Atomic: on any error nothing changes and the
   * predecessor cell gets the error. The predecessor column routes here from `setCell`.
   */
  setPredecessors(rowId: string, raw: string): ActionResult
  removeDependency(predecessorId: string, successorId: string): void
  /** Removes the notice at `index` (no-op when out of range). */
  dismissNotice(index: number): void
  /** Updates the loaded sheet's name locally (the caller saves it to the sheets table). */
  setSheetName(name: string): void
  /**
   * Re-queues every change that ran out of retries (cells with their current values, row places,
   * the current dependency set, pending deletions) and every row whose insert has not succeeded.
   */
  retryFailed(): void
  /**
   * Validates and sets the sheet's working-day calendar (stored deduped and sorted), re-runs the
   * schedule and saves the sheet's settings. Unchanged input is a no-op.
   */
  setCalendar(cal: Calendar): ActionResult
  /**
   * Turns dependencies on or off. Off keeps the dependency rows but stops them driving dates.
   * On is refused while a schedule column holds a formula, or when the dependencies kept while
   * off no longer fit the row tree (a cycle through a parent, or a summary row with predecessors).
   */
  setDependenciesEnabled(on: boolean): ActionResult
}

export interface SheetStoreOptions {
  /** Delay before each retry of a failed persistence call; its length is the retry count. */
  retryDelaysMs?: number[]
}

/** Why a Start date cannot be typed on a row driven by its predecessors (grid, Gantt and store). */
export const START_SET_BY_PREDECESSORS = 'Start date is set by predecessors — edit the Predecessors column to move this task'

/** Whether a row's start comes from its incoming dependencies (so a typed Start would be ignored). */
export function isStartDriven(data: SheetData, rowId: string): boolean {
  return data.sheet.dependenciesEnabled && data.dependencies.some((d) => d.successorId === rowId)
}

/** Columns whose values on a parent row come from its children. */
const ROLLUP_ROLES: readonly ColumnRole[] = ['start', 'end', 'duration', 'percentComplete']

const EMPTY_SCHEDULE: ScheduleResult = { byRow: {}, errors: [] }

function computeSchedule(data: SheetData): ScheduleResult {
  const input = toSchedInput(data)
  if (!input) return EMPTY_SCHEDULE
  const result = schedule(input.rows, input.deps, input.calendar)
  if (result.errors.length === 0) return result
  // The engine names rows by id; users see row numbers.
  const nums = rowNumbers(data)
  const row = (id: string) => (nums.has(id) ? `row ${nums.get(id)}` : id)
  const named = (message: string) => {
    let m = /^Predecessor (\S+) could not be scheduled$/.exec(message)
    if (m) return `Predecessor ${row(m[1])} could not be scheduled`
    m = /^Dependency cycle: (.+)$/.exec(message)
    if (m) return `Dependency cycle: ${m[1].split(' -> ').map(row).join(' -> ')}`
    return message
  }
  return { ...result, errors: result.errors.map((e) => ({ ...e, message: named(e.message) })) }
}

/** Every row's parent link as an edge child -> parent, exactly as schedule() adds them. */
function hierarchyEdges(rows: readonly RowNode[]): SchedDep[] {
  const ids = new Set(rows.map((r) => r.id))
  return rows.flatMap((r) =>
    r.parentId !== null && ids.has(r.parentId) ? [{ predecessorId: r.id, successorId: r.parentId, type: 'FS' as const, lagMinutes: 0 }] : [],
  )
}

/** True if `ancestor` is a strict ancestor of `id` in `rows`. */
function isAncestor(parentOf: Map<string, string | null>, ancestor: string, id: string): boolean {
  const seen = new Set<string>()
  for (let p = parentOf.get(id) ?? null; p !== null && !seen.has(p); p = parentOf.get(p) ?? null) {
    if (p === ancestor) return true
    seen.add(p)
  }
  return false
}

/**
 * A cycle in the dependency graph plus the implicit child -> parent edges the scheduler adds,
 * or null. `pure` is true when every edge of the found cycle is a dependency; otherwise `dep` is
 * a dependency of the cycle whose rows are ancestor and descendant (when there is one).
 */
function findScheduleCycle(
  deps: SchedDep[],
  rows: readonly RowNode[],
): { path: string[]; pure: boolean; dep: SchedDep | null; parentOf: Map<string, string | null> } | null {
  const path = findCycle([...deps, ...hierarchyEdges(rows)])
  if (!path) return null
  const depKeys = new Set(deps.map((d) => `${d.predecessorId}>${d.successorId}`))
  const closed = [...path, path[0]]
  const pure = closed.slice(1).every((to, i) => depKeys.has(`${closed[i]}>${to}`))
  const parentOf = new Map(rows.map((r) => [r.id, r.parentId]))
  const members = new Set(path)
  const dep =
    deps.find(
      (d) =>
        members.has(d.predecessorId) &&
        members.has(d.successorId) &&
        (isAncestor(parentOf, d.predecessorId, d.successorId) || isAncestor(parentOf, d.successorId, d.predecessorId)),
    ) ?? null
  return { path, pure, dep, parentOf }
}

/** At most one dependency links a (predecessor, successor) pair, whatever its type or lag. */
const samePair = (a: SchedDep, b: SchedDep) => a.predecessorId === b.predecessorId && a.successorId === b.successorId

const depKey = (d: SchedDep) => `${d.predecessorId}|${d.successorId}|${d.type}|${d.lagMinutes}`
const sameDepSet = (a: SchedDep[], b: SchedDep[]) => {
  const keys = new Set(a.map(depKey))
  return a.length === b.length && b.every((d) => keys.has(depKey(d)))
}

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
      const failedCount = failedKeys.size
      if (get().saveStatus !== status || get().failedCount !== failedCount) set({ saveStatus: status, failedCount })
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

    /**
     * Insert a not-yet-persisted row with its current cells, parent and position, after any
     * not-yet-persisted ancestors (root first), so the parent foreign key always holds.
     */
    async function insertNow(rowId: string): Promise<void> {
      const data = get().data
      if (!data) return
      const chain: string[] = []
      for (let id: string | null = rowId; id !== null && unpersisted.has(id) && !chain.includes(id); ) {
        chain.unshift(id)
        id = data.rows.find((r) => r.id === id)?.parentId ?? null
      }
      for (const id of chain) {
        const row = get().data?.rows.find((r) => r.id === id)
        if (!row || !unpersisted.has(id)) continue
        await p.insertRow(data.sheet.id, row)
        unpersisted.delete(id)
        // The insert carried the row's place and every cell's current value, so earlier failures
        // for them are resolved. A job still queued or in flight re-adds its key if it fails.
        for (const key of [...failedKeys]) {
          if (key === `tree:${id}` || key.startsWith(`cell:${id}:`)) failedKeys.delete(key)
        }
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
          // Its new parent may be a row whose insert has not succeeded yet.
          if (row.parentId !== null && unpersisted.has(row.parentId)) await insertNow(row.parentId)
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

    /** Persist the sheet's current calendar and dependencies flag (the latest state wins). */
    function enqueueSettings(sheetId: string): void {
      enqueue({
        key: 'settings',
        async run() {
          const sheet = get().data?.sheet
          if (!sheet || sheet.id !== sheetId) return
          await p.saveSheetSettings(sheetId, { calendar: sheet.calendar, dependenciesEnabled: sheet.dependenciesEnabled })
        },
      })
    }

    /** Replace data and recompute the schedule. */
    function commit(data: SheetData, extra: Partial<SheetState> = {}): void {
      set({ data, scheduled: computeSchedule(data), ...extra })
    }

    /**
     * Apply a hierarchy operation; a no-op (same array) does nothing at all. A change that would
     * make a task depend on its own parent or sub-task (a cycle through the scheduler's
     * child -> parent edges) is refused with a notice instead.
     */
    function applyTree(verb: string, op: (rows: RowNode[]) => RowNode[]): void {
      const data = get().data
      if (!data) return
      const next = op(data.rows)
      if (next === data.rows) return
      if (data.sheet.dependenciesEnabled) {
        const problem = treeCycleNotice(data, next, verb) ?? newSummaryWithPredecessors(data, next, verb)
        if (problem) {
          set({ notices: [...get().notices, problem] })
          return
        }
      }
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

    /**
     * The cycle error for a candidate dependency set, naming rows by number; null if acyclic.
     * Hierarchy-aware: a parent's dates come from its children, so depending on one's own
     * parent or sub-task is a cycle too.
     */
    function cycleError(data: SheetData, deps: SchedDep[]): string | null {
      const cycle = findScheduleCycle(deps, data.rows)
      if (!cycle) return null
      const nums = rowNumbers(data)
      const label = (id: string) => `row ${nums.get(id) ?? '?'}`
      if (cycle.pure) return `Dependency would create a cycle: ${[...cycle.path, cycle.path[0]].map(label).join(' -> ')}`
      const pair = cycle.dep ? [cycle.dep.predecessorId, cycle.dep.successorId] : [...cycle.path, cycle.path[0]]
      return `A task cannot depend on its own parent or sub-task (${pair.map(label).join(' -> ')})`
    }

    /**
     * A tree change must not turn a row with predecessors into a summary (parent) row: summary
     * rows take their dates from their children and cannot have predecessors.
     */
    function newSummaryWithPredecessors(data: SheetData, next: readonly RowNode[], verb: string): string | null {
      const wasParent = new Set(data.rows.map((r) => r.parentId))
      const driven = new Set(data.dependencies.map((d) => d.successorId))
      const row = next.find((r) => r.parentId !== null && !wasParent.has(r.parentId) && driven.has(r.parentId))
      if (!row) return null
      const n = rowNumbers(data).get(row.parentId!)
      return `Can't ${verb}: row ${n} has predecessors, and summary rows cannot have predecessors`
    }

    /** Why a tree change (rows -> next) cannot be applied, or null when it can. */
    function treeCycleNotice(data: SheetData, next: readonly RowNode[], verb: string): string | null {
      const cycle = findScheduleCycle(data.dependencies, next)
      if (!cycle) return null
      const nums = rowNumbers(data) // the numbers the user sees now
      const label = (id: string) => `row ${nums.get(id) ?? '?'}`
      const d = cycle.dep
      if (d) {
        const pred = d.predecessorId
        const succ = d.successorId
        let relation: string
        if (isAncestor(cycle.parentOf, pred, succ)) {
          relation = cycle.parentOf.get(succ) === pred ? 'its parent' : 'one of its parent rows'
        } else {
          relation = cycle.parentOf.get(pred) === succ ? 'its sub-task' : 'one of its sub-tasks'
        }
        return `Can't ${verb}: ${label(succ)} depends on ${label(pred)}, which would become ${relation}`
      }
      const path = [...cycle.path, cycle.path[0]].map(label).join(' -> ')
      return `Can't ${verb}: it would make a task depend on its own parent or sub-task (${path})`
    }

    /** Replace the cell's error (if any) with `message`, or clear it when `message` is null. */
    function cellErrors(rowId: string, colId: string | undefined, message: string | null): CellError[] {
      const others = get().errors.filter((e) => !(e.rowId === rowId && e.colId === colId))
      return message !== null && colId !== undefined ? [...others, { rowId, colId, message }] : others
    }

    return {
      data: null,
      scheduled: EMPTY_SCHEDULE,
      saveStatus: 'saved',
      failedCount: 0,
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
        // Predecessors are not stored in cells: the text is derived from the dependencies.
        if (col.role === 'predecessor') return get().setPredecessors(rowId, raw)
        if (col.role && ROLLUP_ROLES.includes(col.role) && isParent(data, rowId)) {
          return { ok: false, error: `${col.title} on a summary row is calculated from its child rows` }
        }
        if (col.role === 'start' && isStartDriven(data, rowId)) {
          set({ errors: cellErrors(rowId, colId, START_SET_BY_PREDECESSORS) })
          return { ok: false, error: START_SET_BY_PREDECESSORS }
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
        applyTree('indent', (rows) => indent(rows, id))
      },

      outdentRow(id) {
        applyTree('outdent', (rows) => outdent(rows, id))
      },

      moveRow(id, afterId, newParentId) {
        applyTree('move', (rows) => moveRowInTree(rows, id, afterId, newParentId))
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
        if (data.dependencies.some((d) => samePair(d, dep))) {
          return { ok: false, error: 'A dependency between these rows already exists' }
        }
        if (isParent(data, dep.successorId)) return { ok: false, error: 'Summary rows cannot have predecessors' }
        const deps = [...data.dependencies, dep]
        const cycle = cycleError(data, deps)
        if (cycle) return { ok: false, error: cycle }
        commit({ ...data, dependencies: deps })
        enqueueDependencies(data.sheet.id, deps)
        return { ok: true }
      },

      setPredecessors(rowId, raw) {
        const data = get().data
        if (!data) return { ok: false, error: 'Sheet is not loaded' }
        if (!data.rows.some((r) => r.id === rowId)) return { ok: false, error: `Unknown row ${rowId}` }
        const col = data.columns.find((c) => c.role === 'predecessor')
        const fail = (error: string): ActionResult => {
          set({ errors: cellErrors(rowId, col?.id, error) })
          return { ok: false, error }
        }

        if (!data.sheet.dependenciesEnabled) return fail('Dependencies are not enabled for this sheet')
        if (col) {
          // Same checks (and messages) as any predecessor cell: syntax, row count, self reference.
          const valid = validateCell(col, raw, {
            rowCount: data.rows.length,
            ownRowNumber: fullOrder(data.rows).indexOf(rowId) + 1,
            hoursPerDay: data.sheet.calendar.hoursPerDay,
            dependenciesEnabled: true,
          })
          if (!valid.ok) return fail(valid.error)
        }
        const parsed = parsePredecessorInput(data, rowId, raw)
        if (!parsed.ok) return fail(parsed.error)
        if (parsed.deps.length > 0 && isParent(data, rowId)) return fail('Summary rows cannot have predecessors')
        const deps = [...data.dependencies.filter((d) => d.successorId !== rowId), ...parsed.deps]
        const cycle = cycleError(data, deps)
        if (cycle) return fail(cycle)

        const errors = cellErrors(rowId, col?.id, null)
        if (sameDepSet(deps, data.dependencies)) {
          set({ errors }) // nothing changed; re-entering the same text only clears the error
          return { ok: true }
        }
        commit({ ...data, dependencies: deps }, { errors })
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

      retryFailed() {
        const data = get().data
        if (!data) return
        for (const key of [...failedKeys]) {
          if (key === 'deps') enqueueDependencies(data.sheet.id, data.dependencies)
          else if (key === 'settings') enqueueSettings(data.sheet.id)
          else if (key === 'delete') enqueueDelete([])
          else if (key.startsWith('tree:')) {
            const rowId = key.slice('tree:'.length)
            if (findRow(rowId)) enqueueTree(rowId)
            else failedKeys.delete(key)
          } else if (key.startsWith('cell:')) {
            const rest = key.slice('cell:'.length)
            const sep = rest.indexOf(':')
            const rowId = rest.slice(0, sep)
            const colId = rest.slice(sep + 1)
            const row = findRow(rowId)
            if (row) enqueueCell(rowId, colId, row.cells[colId])
            else failedKeys.delete(key)
          }
        }
        // Rows whose insert never succeeded (whatever job last tried it).
        for (const id of unpersisted) if (findRow(id) && !queue.some((j) => j.key === `tree:${id}`)) enqueueTree(id)
        refreshStatus()
      },

      setSheetName(name) {
        const data = get().data
        if (!data) return
        // The schedule does not depend on the name, so it is kept as is.
        set({ data: { ...data, sheet: { ...data.sheet, name } } })
      },

      setCalendar(cal) {
        const data = get().data
        if (!data) return { ok: false, error: 'Sheet is not loaded' }
        const norm = normalizeCalendar(cal)
        if (!norm.ok) return norm
        if (sameCalendar(norm.calendar, data.sheet.calendar)) return { ok: true }
        commit({ ...data, sheet: { ...data.sheet, calendar: norm.calendar } })
        enqueueSettings(data.sheet.id)
        return { ok: true }
      },

      setDependenciesEnabled(on) {
        const data = get().data
        if (!data) return { ok: false, error: 'Sheet is not loaded' }
        if (data.sheet.dependenciesEnabled === on) return { ok: true }
        if (on) {
          const formula = scheduleFormulaProblem(data)
          if (formula) return { ok: false, error: formula }
          // While off, the tree could change in ways dependencies would not allow (see applyTree).
          const cycle = cycleError(data, data.dependencies)
          if (cycle) return { ok: false, error: `Can't turn on dependencies: ${cycle}` }
          const summary = data.dependencies.find((d) => isParent(data, d.successorId))
          if (summary) {
            const n = rowNumbers(data).get(summary.successorId)
            return { ok: false, error: `Can't turn on dependencies: row ${n} is a summary row with predecessors; remove them first` }
          }
        }
        // A refused Start on a row that is no longer driven would be a stale error.
        const errors = on ? get().errors : get().errors.filter((e) => e.message !== START_SET_BY_PREDECESSORS)
        commit({ ...data, sheet: { ...data.sheet, dependenciesEnabled: on } }, { errors })
        enqueueSettings(data.sheet.id)
        return { ok: true }
      },

      dismissNotice(index) {
        const notices = get().notices
        if (index < 0 || index >= notices.length) return
        set({ notices: notices.filter((_, i) => i !== index) })
      },
    }
  })

  return store
}
