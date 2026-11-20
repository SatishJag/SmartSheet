import { createStore, type StoreApi } from 'zustand/vanilla'
import { buildLoad, type Allocation, type Assignment, type LoadModel, type Resource, type TaskFact } from './engine'
import type { ResourcePersistence } from './persistence'

export type ActionResult = { ok: true } | { ok: false; error: string }

export interface NewAssignment {
  sheetId: string
  rowId: string
  resourceId: string
  allocation: Allocation
  startDate?: string | null
  endDate?: string | null
}

export interface ResourceState {
  resources: Resource[]
  assignments: Assignment[]
  /** Task facts by sheet id: every sheet that has assignments, plus the open sheet when it is live. */
  tasks: Record<string, TaskFact[]>
  sheetNames: Record<string, string>
  /** Resources and assignments are loaded. */
  loaded: boolean
  /** Tasks of the sheets behind the assignments are still loading. */
  tasksLoading: boolean
  loadError: string | null

  /** Loads resources and every assignment, then the tasks of each sheet that has assignments. */
  loadAll(): Promise<void>
  /**
   * Gives the store a sheet's tasks from outside (the open sheet's live schedule), so assignments follow
   * the task the moment its dates change. A live sheet is never fetched by `loadAll`.
   */
  setLiveSheet(sheetId: string, sheetName: string, tasks: TaskFact[]): void

  saveResource(resource: Resource): Promise<ActionResult>
  deleteResource(id: string): Promise<ActionResult>
  /** Assigns a resource to a task, or updates the existing assignment of that pair. Not optimistic. */
  assign(input: NewAssignment): Promise<ActionResult>
  unassign(id: string): Promise<ActionResult>
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))
const sameTask = (a: Assignment, i: NewAssignment) => a.sheetId === i.sheetId && a.rowId === i.rowId && a.resourceId === i.resourceId

/** How many sheets are loaded at once when building the workload. */
const SHEET_LOAD_CONCURRENCY = 4

export function createResourceStore(p: ResourcePersistence): StoreApi<ResourceState> {
  const live = new Set<string>()
  let loading: Promise<void> | null = null

  return createStore<ResourceState>()((set, get) => ({
    resources: [],
    assignments: [],
    tasks: {},
    sheetNames: {},
    loaded: false,
    tasksLoading: false,
    loadError: null,

    loadAll() {
      // One load at a time; a second caller shares it.
      if (loading) return loading
      loading = (async () => {
        try {
          const [resources, assignments] = await Promise.all([p.loadResources(), p.loadAssignments()])
          set({ resources, assignments, loaded: true, loadError: null, tasksLoading: true })
          const sheetIds = [...new Set(assignments.map((a) => a.sheetId))].filter((id) => !live.has(id))
          const failed: string[] = []
          let next = 0
          const worker = async () => {
            while (next < sheetIds.length) {
              const id = sheetIds[next++]
              try {
                const s = await p.loadSheetTasks(id)
                if (!live.has(id)) {
                  const now = get()
                  set({ tasks: { ...now.tasks, [id]: s.tasks }, sheetNames: { ...now.sheetNames, [id]: s.sheetName } })
                }
              } catch {
                failed.push(id)
              }
            }
          }
          await Promise.all(Array.from({ length: Math.min(SHEET_LOAD_CONCURRENCY, sheetIds.length) }, worker))
          set({
            tasksLoading: false,
            loadError: failed.length > 0 ? `Could not load ${failed.length} sheet${failed.length === 1 ? '' : 's'} with assignments; their work is missing from the totals.` : null,
          })
        } catch (e) {
          set({ loadError: errorMessage(e), tasksLoading: false })
        } finally {
          loading = null
        }
      })()
      return loading
    },

    setLiveSheet(sheetId, sheetName, tasks) {
      live.add(sheetId)
      const now = get()
      if (now.tasks[sheetId] === tasks && now.sheetNames[sheetId] === sheetName) return
      set({ tasks: { ...now.tasks, [sheetId]: tasks }, sheetNames: { ...now.sheetNames, [sheetId]: sheetName } })
    },

    async saveResource(resource) {
      try {
        await p.saveResource(resource)
      } catch (e) {
        return { ok: false, error: errorMessage(e) }
      }
      const now = get()
      const exists = now.resources.some((r) => r.id === resource.id)
      const resources = (exists ? now.resources.map((r) => (r.id === resource.id ? resource : r)) : [...now.resources, resource]).sort(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      )
      set({ resources })
      return { ok: true }
    },

    async deleteResource(id) {
      try {
        await p.deleteResource(id)
      } catch (e) {
        return { ok: false, error: errorMessage(e) }
      }
      const now = get()
      // Its assignments go with it in the database.
      set({ resources: now.resources.filter((r) => r.id !== id), assignments: now.assignments.filter((a) => a.resourceId !== id) })
      return { ok: true }
    },

    async assign(input) {
      const existing = get().assignments.find((a) => sameTask(a, input))
      const a: Assignment = {
        id: existing?.id ?? crypto.randomUUID(),
        sheetId: input.sheetId,
        rowId: input.rowId,
        resourceId: input.resourceId,
        allocation: input.allocation,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
      }
      try {
        await p.saveAssignment(a)
      } catch (e) {
        return { ok: false, error: errorMessage(e) }
      }
      const now = get()
      set({ assignments: existing ? now.assignments.map((x) => (x.id === a.id ? a : x)) : [...now.assignments, a] })
      return { ok: true }
    },

    async unassign(id) {
      try {
        await p.deleteAssignment(id)
      } catch (e) {
        return { ok: false, error: errorMessage(e) }
      }
      set({ assignments: get().assignments.filter((a) => a.id !== id) })
      return { ok: true }
    },
  }))
}

// ---- selectors --------------------------------------------------------------------------------

const flatCache = new WeakMap<ResourceState['tasks'], TaskFact[]>()
/** Every known task, flattened (memoised on the `tasks` object). */
export function allTasks(state: Pick<ResourceState, 'tasks'>): TaskFact[] {
  let flat = flatCache.get(state.tasks)
  if (!flat) {
    flat = Object.values(state.tasks).flat()
    flatCache.set(state.tasks, flat)
  }
  return flat
}

const modelCache = new WeakMap<Assignment[], { resources: Resource[]; tasks: TaskFact[]; model: LoadModel }>()
/** The load model for the current state, rebuilt only when resources, assignments or tasks change. */
export function loadModel(state: Pick<ResourceState, 'resources' | 'assignments' | 'tasks'>): LoadModel {
  const tasks = allTasks(state)
  const hit = modelCache.get(state.assignments)
  if (hit && hit.resources === state.resources && hit.tasks === tasks) return hit.model
  const model = buildLoad(state.resources, state.assignments, tasks)
  modelCache.set(state.assignments, { resources: state.resources, tasks, model })
  return model
}
