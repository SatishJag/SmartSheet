/**
 * A construction schedule for WhatsApp tests (no test-framework imports, so server tests can use it).
 * Calendar Mon-Fri; "today" in tests is Thursday 2026-11-19.
 *
 *   1 Substructure (summary)
 *   2   Excavation        2026-11-02..06  Done 100%                      critical (drives the chain)
 *   3   Pour slab L1      2026-11-09..13  In progress 40%  ravi          FS after 2; 6 days late, critical
 *   4   Rebar delivery    2026-11-09..11  Not started      meena         8 days late, float 12
 *   5 Superstructure (summary)
 *   6   Columns L2        2026-11-16..27  Not started      ravi          FS after 3; critical
 *   7   Topping out       milestone 2026-11-27                           FS after 6; critical
 *   8   Facade mock-up    2026-11-23..25  Not started      meena
 */
import type { Column } from '../../model/validate'
import type { SheetData } from '../../store/persistence'

export const WCOL = {
  task: 'w-task',
  trade: 'w-trade',
  start: 'w-start',
  end: 'w-end',
  duration: 'w-dur',
  pred: 'w-pred',
  status: 'w-status',
  percent: 'w-pct',
  owner: 'w-owner',
  comments: 'w-comments',
} as const

export const waColumns: Column[] = [
  { id: WCOL.task, title: 'Task', type: 'TEXT_NUMBER' },
  { id: WCOL.trade, title: 'Trade', type: 'PICKLIST', options: ['Concrete', 'Steel', 'Facade'] },
  { id: WCOL.duration, title: 'Duration', type: 'DURATION', role: 'duration' },
  { id: WCOL.start, title: 'Start', type: 'DATE', role: 'start' },
  { id: WCOL.end, title: 'End', type: 'DATE', role: 'end' },
  { id: WCOL.pred, title: 'Predecessors', type: 'PREDECESSOR', role: 'predecessor' },
  { id: WCOL.status, title: 'Status', type: 'PICKLIST', role: 'status', options: ['Not started', 'In progress', 'On hold', 'Complete'] },
  { id: WCOL.percent, title: '% Complete', type: 'TEXT_NUMBER', role: 'percentComplete' },
  { id: WCOL.owner, title: 'Responsible', type: 'CONTACT_LIST' },
  { id: WCOL.comments, title: 'Comments', type: 'TEXT_NUMBER' },
]

export const RAVI = 'ravi@sub.example'
export const MEENA = 'meena@sub.example'
export const WA_TODAY = '2026-11-19'

const row = (id: string, position: string, cells: Record<string, unknown>, parentId: string | null = null) => ({ id, parentId, position, cells, version: 1 })

export function waSheet(overrides: Partial<SheetData> = {}): SheetData {
  return {
    sheet: {
      id: 'sheet-wa',
      name: 'Tower A',
      ownerId: 'owner-1',
      workspaceId: 'owner-1',
      calendar: { workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 },
      dependenciesEnabled: true,
    },
    columns: waColumns,
    rows: [
      row('r-sub', 'a0', { [WCOL.task]: 'Substructure' }),
      row('r-exc', 'a0', { [WCOL.task]: 'Excavation', [WCOL.trade]: 'Concrete', [WCOL.start]: '2026-11-02', [WCOL.duration]: '5d', [WCOL.status]: 'Complete', [WCOL.percent]: 100 }, 'r-sub'),
      row('r-slab', 'a1', { [WCOL.task]: 'Pour slab L1', [WCOL.trade]: 'Concrete', [WCOL.start]: '2026-11-09', [WCOL.duration]: '5d', [WCOL.status]: 'In progress', [WCOL.percent]: 40, [WCOL.owner]: RAVI }, 'r-sub'),
      row('r-rebar', 'a2', { [WCOL.task]: 'Rebar delivery', [WCOL.trade]: 'Steel', [WCOL.start]: '2026-11-09', [WCOL.duration]: '3d', [WCOL.status]: 'Not started', [WCOL.owner]: MEENA }, 'r-sub'),
      row('r-sup', 'a1', { [WCOL.task]: 'Superstructure' }),
      row('r-col', 'a0', { [WCOL.task]: 'Columns L2', [WCOL.trade]: 'Concrete', [WCOL.start]: '2026-11-16', [WCOL.duration]: '10d', [WCOL.status]: 'Not started', [WCOL.owner]: RAVI }, 'r-sup'),
      row('r-top', 'a1', { [WCOL.task]: 'Topping out', [WCOL.start]: '2026-11-27', [WCOL.duration]: '0d', [WCOL.status]: 'Not started' }, 'r-sup'),
      row('r-fac', 'a2', { [WCOL.task]: 'Facade mock-up', [WCOL.trade]: 'Facade', [WCOL.start]: '2026-11-23', [WCOL.duration]: '3d', [WCOL.status]: 'Not started', [WCOL.owner]: MEENA }, 'r-sup'),
    ],
    dependencies: [
      { predecessorId: 'r-exc', successorId: 'r-slab', type: 'FS', lagMinutes: 0 },
      { predecessorId: 'r-slab', successorId: 'r-col', type: 'FS', lagMinutes: 0 },
      { predecessorId: 'r-col', successorId: 'r-top', type: 'FS', lagMinutes: 0 },
    ],
    ...overrides,
  }
}
