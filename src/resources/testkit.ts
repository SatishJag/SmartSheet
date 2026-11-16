import { vi } from 'vitest'
import type { Calendar } from '../engine/types'
import { workingDayNumbers, type Assignment, type Resource, type TaskFact } from './engine'
import type { ResourcePersistence } from './persistence'
import type { Persistence, SheetData } from '../store/persistence'

/** Small builders shared by the resource tests. */
export const CAL: Calendar = { workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 }

export const person = (id: string, over: Partial<Resource> = {}): Resource => ({
  id,
  name: id,
  kind: 'person',
  department: null,
  skills: [],
  costRate: 0,
  hoursByWeekday: [0, 8, 8, 8, 8, 8, 0],
  timeOff: [],
  ...over,
})

export const task = (rowId: string, start: string, end: string, over: Partial<TaskFact> = {}): TaskFact => ({
  sheetId: 's1',
  rowId,
  name: `Task ${rowId}`,
  start,
  end,
  durationDays: workingDayNumbers(start, end, CAL).length,
  elapsed: false,
  calendar: CAL,
  totalFloat: 0,
  freeFloat: 0,
  critical: true,
  ...over,
})

export const assign = (id: string, resourceId: string, rowId: string, allocation: Assignment['allocation'], over: Partial<Assignment> = {}): Assignment => ({
  id,
  sheetId: 's1',
  rowId,
  resourceId,
  allocation,
  startDate: null,
  endDate: null,
  ...over,
})


/** An in-memory resource persistence (spies), for store and component tests. */
export function memory(initial: { resources?: Resource[]; assignments?: Assignment[]; sheets?: Record<string, { name: string; tasks: TaskFact[] }> } = {}) {
  let resources = [...(initial.resources ?? [])]
  let assignments = [...(initial.assignments ?? [])]
  const sheets = initial.sheets ?? {}
  const p: ResourcePersistence = {
    loadResources: vi.fn(async () => resources),
    saveResource: vi.fn(async (r: Resource) => {
      resources = resources.some((x) => x.id === r.id) ? resources.map((x) => (x.id === r.id ? r : x)) : [...resources, r]
    }),
    deleteResource: vi.fn(async (id: string) => {
      resources = resources.filter((r) => r.id !== id)
      assignments = assignments.filter((a) => a.resourceId !== id)
    }),
    loadAssignments: vi.fn(async (sheetId?: string) => assignments.filter((a) => !sheetId || a.sheetId === sheetId)),
    saveAssignment: vi.fn(async (a: Assignment) => {
      assignments = assignments.some((x) => x.id === a.id) ? assignments.map((x) => (x.id === a.id ? a : x)) : [...assignments, a]
    }),
    deleteAssignment: vi.fn(async (id: string) => {
      assignments = assignments.filter((a) => a.id !== id)
    }),
    loadSheetTasks: vi.fn(async (sheetId: string) => ({ sheetId, sheetName: sheets[sheetId].name, tasks: sheets[sheetId].tasks })),
  }
  return p
}

/** A sheet persistence that holds `data` and accepts every write (for driving a real sheet store in tests). */
export function sheetPersistence(data: SheetData): Persistence {
  return {
    loadSheet: vi.fn(async () => structuredClone(data)),
    saveCell: vi.fn(async (_r: string, _c: string, _v: unknown, version: number) => ({ version: version + 1 })),
    insertRow: vi.fn(async () => {}),
    saveRowTree: vi.fn(async () => {}),
    saveDependencies: vi.fn(async () => {}),
    deleteRows: vi.fn(async () => {}),
    saveSheetSettings: vi.fn(async () => {}),
    insertColumn: vi.fn(async () => {}),
    updateColumn: vi.fn(async () => {}),
    saveColumnOrder: vi.fn(async () => {}),
    deleteColumn: vi.fn(async () => {}),
    saveColumnCells: vi.fn(async () => {}),
    loadBaselineRows: vi.fn(async () => []),
    saveBaseline: vi.fn(),
    deleteBaseline: vi.fn(async () => {}),
  } as unknown as Persistence
}
