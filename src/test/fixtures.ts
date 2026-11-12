import { vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import { defaultCalendar } from '../engine/calendar'
import type { SchedDep } from '../engine/schedule'
import type { Column } from '../model/validate'
import type { Persistence, RowRecord, SheetData, SheetSettings } from '../store/persistence'
import { createSheetStore, type SheetState, type SheetStoreOptions } from '../store/sheetStore'

/** Column ids of the fixture sheet, so tests do not depend on titles. */
export const COL = {
  task: 'c-task',
  start: 'c-start',
  end: 'c-end',
  duration: 'c-dur',
  predecessors: 'c-pred',
  percent: 'c-pct',
  status: 'c-status',
} as const

export const fixtureColumns: Column[] = [
  { id: COL.task, title: 'Task', type: 'TEXT_NUMBER' },
  { id: COL.start, title: 'Start', type: 'DATE', role: 'start' },
  { id: COL.end, title: 'End', type: 'DATE', role: 'end' },
  { id: COL.duration, title: 'Duration', type: 'DURATION', role: 'duration' },
  { id: COL.predecessors, title: 'Predecessors', type: 'PREDECESSOR', role: 'predecessor' },
  { id: COL.percent, title: '% Complete', type: 'TEXT_NUMBER', role: 'percentComplete' },
  { id: COL.status, title: 'Status', type: 'PICKLIST', role: 'status', options: ['Not started', 'In progress', 'Done'] },
]

export function makeRow(id: string, position: string, cells: Record<string, unknown>, parentId: string | null = null): RowRecord {
  return { id, parentId, position, cells, version: 0 }
}

export const fsDep = (predecessorId: string, successorId: string): SchedDep => ({
  predecessorId,
  successorId,
  type: 'FS',
  lagMinutes: 0,
})

/**
 * A small realistic sheet. 2026-11-09 is a Monday; calendar Mon-Fri, 8h days.
 * Tree order (row numbers): 1 r-site (parent), 2 r-survey, 3 r-clear, 4 r-found.
 * Dependencies: r-survey -> r-clear (FS), r-clear -> r-found (FS). Predecessor text is derived
 * from these (the predecessor column is never stored in cells).
 */
export function makeSheetData(overrides: Partial<SheetData> = {}): SheetData {
  return {
    sheet: {
      id: 'sheet-1',
      name: 'Tower A',
      ownerId: 'user-1',
      workspaceId: 'user-1',
      calendar: defaultCalendar,
      dependenciesEnabled: true,
    },
    columns: fixtureColumns,
    rows: [
      makeRow('r-site', 'a0', { [COL.task]: 'Site preparation' }),
      makeRow(
        'r-survey',
        'a0',
        { [COL.task]: 'Survey', [COL.start]: '2026-11-09', [COL.duration]: '2d', [COL.percent]: 100, [COL.status]: 'Done' },
        'r-site',
      ),
      makeRow(
        'r-clear',
        'a1',
        { [COL.task]: 'Clear site', [COL.duration]: '3d', [COL.percent]: 50, [COL.status]: 'In progress' },
        'r-site',
      ),
      makeRow('r-found', 'a1', {
        [COL.task]: 'Foundations',
        [COL.duration]: '5d',
        [COL.status]: 'Not started',
      }),
    ],
    dependencies: [fsDep('r-survey', 'r-clear'), fsDep('r-clear', 'r-found')],
    ...overrides,
  }
}

/** A fake Persistence whose calls all succeed; `loadSheet` returns a copy of `data`. */
export function makeFakePersistence(data: SheetData = makeSheetData()) {
  return {
    loadSheet: vi.fn(async (_id: string) => structuredClone(data)),
    saveCell: vi.fn(async (_rowId: string, _colId: string, _value: unknown, version: number) => ({ version: version + 1 })),
    insertRow: vi.fn(async (_sheetId: string, _row: RowRecord) => {}),
    saveRowTree: vi.fn(async () => {}),
    saveDependencies: vi.fn(async () => {}),
    deleteRows: vi.fn(async () => {}),
    saveSheetSettings: vi.fn(async (_sheetId: string, _settings: SheetSettings) => {}),
  } satisfies Persistence
}

export type FakePersistence = ReturnType<typeof makeFakePersistence>

/**
 * A real sheet store over a fake persistence, already loaded with `data`.
 * Async because loading goes through the store's own `load`.
 */
export async function makeTestStore(
  data: SheetData = makeSheetData(),
  opts: SheetStoreOptions = { retryDelaysMs: [0, 0, 0] },
): Promise<{ store: StoreApi<SheetState>; persistence: FakePersistence }> {
  const persistence = makeFakePersistence(data)
  const store = createSheetStore(persistence, opts)
  await store.getState().load(data.sheet.id)
  return { store, persistence }
}
