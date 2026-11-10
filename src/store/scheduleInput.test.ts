import { describe, expect, it } from 'vitest'
import { defaultCalendar } from '../engine/calendar'
import type { Column } from '../model/validate'
import type { RowRecord, SheetData } from './persistence'
import { toSchedInput } from './scheduleInput'

const cols: Column[] = [
  { id: 'name', title: 'Task', type: 'TEXT_NUMBER' },
  { id: 's', title: 'Begins', type: 'DATE', role: 'start' },
  { id: 'd', title: 'Length', type: 'DURATION', role: 'duration' },
  { id: 'p', title: 'Done', type: 'TEXT_NUMBER', role: 'percentComplete' },
]

const row = (id: string, position: string, cells: Record<string, unknown>, parentId: string | null = null): RowRecord => ({
  id,
  parentId,
  position,
  cells,
  version: 0,
})

function sheet(overrides: Partial<SheetData> = {}): SheetData {
  return {
    sheet: {
      id: 'sh',
      name: 'S',
      ownerId: 'u',
      workspaceId: 'u',
      calendar: defaultCalendar,
      dependenciesEnabled: true,
    },
    columns: cols,
    rows: [
      row('r1', 'a0', { s: '2026-11-09', d: '2d', p: 50 }),
      row('r2', 'a1', { d: 'e3d' }),
    ],
    dependencies: [{ predecessorId: 'r1', successorId: 'r2', type: 'FS', lagMinutes: 0 }],
    ...overrides,
  }
}

describe('toSchedInput', () => {
  it('returns null when no column has the start role', () => {
    expect(toSchedInput(sheet({ columns: cols.filter((c) => c.role !== 'start') }))).toBeNull()
  })

  it('finds columns by role, not title', () => {
    const input = toSchedInput(sheet())!
    expect(input.rows[0]).toEqual({
      id: 'r1',
      parentId: null,
      durationMinutes: 2 * 8 * 60,
      elapsed: false,
      manualStart: '2026-11-09',
      percentComplete: 50,
    })
    expect(input.rows[1]).toMatchObject({ id: 'r2', durationMinutes: 3 * 24 * 60, elapsed: true, manualStart: null, percentComplete: 0 })
    expect(input.calendar).toBe(defaultCalendar)
    expect(input.deps).toHaveLength(1)
  })

  it('treats a blank or missing duration as one working day', () => {
    const input = toSchedInput(sheet({ rows: [row('r1', 'a0', { s: '2026-11-09', d: null }), row('r2', 'a1', {})] }))!
    for (const r of input.rows) {
      expect(r.durationMinutes).toBe(8 * 60)
      expect(r.elapsed).toBe(false)
    }
  })

  it('uses the calendar hours per day for durations', () => {
    const cal = { ...defaultCalendar, hoursPerDay: 10 }
    const base = sheet()
    const input = toSchedInput({ ...base, sheet: { ...base.sheet, calendar: cal }, rows: [row('r1', 'a0', { d: '2d' }), row('r2', 'a1', {})] })!
    expect(input.rows[0].durationMinutes).toBe(2 * 10 * 60)
    expect(input.rows[1].durationMinutes).toBe(10 * 60)
  })

  it('ignores a start cell that is not an ISO date', () => {
    const input = toSchedInput(sheet({ rows: [row('r1', 'a0', { s: '=TODAY()' })] }))!
    expect(input.rows[0].manualStart).toBeNull()
  })

  it('drops dependencies when dependencies are disabled', () => {
    const base = sheet()
    const input = toSchedInput({ ...base, sheet: { ...base.sheet, dependenciesEnabled: false } })!
    expect(input.deps).toEqual([])
  })
})
