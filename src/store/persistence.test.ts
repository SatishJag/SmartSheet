import { describe, expect, it } from 'vitest'
import {
  columnFromDb,
  columnToDb,
  dependencyFromDb,
  dependencyToDb,
  rowFromDb,
  rowToDb,
  sheetFromDb,
  type SheetMeta,
} from './persistence'

const meta: SheetMeta = {
  id: 'sh',
  name: 'Tower A',
  ownerId: 'own',
  workspaceId: 'ws',
  calendar: { workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 },
  dependenciesEnabled: true,
}

describe('DB mappers', () => {
  it('maps a sheet row', () => {
    expect(
      sheetFromDb({
        id: 'sh',
        name: 'Tower A',
        owner_id: 'own',
        workspace_id: 'ws',
        calendar: meta.calendar,
        dependencies_enabled: true,
        created_at: '2026-11-09T00:00:00Z',
      }),
    ).toEqual(meta)
  })

  it('maps a column row, omitting null optional fields', () => {
    expect(
      columnFromDb({
        id: 'c1',
        sheet_id: 'sh',
        title: 'Start',
        type: 'DATE',
        position: 2,
        options: null,
        system_type: null,
        role: 'start',
        width: null,
      }),
    ).toEqual({ id: 'c1', title: 'Start', type: 'DATE', role: 'start' })
    expect(
      columnFromDb({
        id: 'c2',
        sheet_id: 'sh',
        title: 'Status',
        type: 'PICKLIST',
        position: 3,
        options: ['Open', 'Done'],
        system_type: 'AUTO',
        role: null,
        width: 120,
      }),
    ).toEqual({ id: 'c2', title: 'Status', type: 'PICKLIST', options: ['Open', 'Done'], systemType: 'AUTO' })
  })

  it('maps rows both ways', () => {
    const db = {
      id: 'r1',
      sheet_id: 'sh',
      owner_id: 'own',
      workspace_id: 'ws',
      parent_id: null,
      position: 'a0',
      cells: { c1: '2026-11-09' },
      version: 3,
    }
    const rec = rowFromDb(db)
    expect(rec).toEqual({ id: 'r1', parentId: null, position: 'a0', cells: { c1: '2026-11-09' }, version: 3 })
    expect(rowToDb(rec, meta)).toEqual(db)
    expect(rowFromDb({ ...db, cells: null }).cells).toEqual({})
  })

  it('maps dependencies both ways', () => {
    const db = {
      id: 'd1',
      sheet_id: 'sh',
      owner_id: 'own',
      workspace_id: 'ws',
      predecessor_row_id: 'r1',
      successor_row_id: 'r2',
      type: 'SS',
      lag_minutes: -480,
    }
    const dep = dependencyFromDb(db)
    expect(dep).toEqual({ predecessorId: 'r1', successorId: 'r2', type: 'SS', lagMinutes: -480 })
    expect(dependencyToDb(dep, meta, 'd1')).toEqual(db)
  })
})

describe('columnToDb', () => {
  it('maps a column to a DB row with position and ownership, and round-trips through columnFromDb', () => {
    const cols = [
      { id: 'c1', title: 'Task', type: 'TEXT_NUMBER' as const },
      { id: 'c2', title: 'Status', type: 'PICKLIST' as const, options: ['A', 'B'], role: 'status' as const },
      { id: 'c3', title: 'X', type: 'TEXT_NUMBER' as const, systemType: 'sys' },
    ]
    cols.forEach((c, i) => {
      const db = columnToDb(c, i, meta)
      expect(db).toMatchObject({ id: c.id, sheet_id: 'sh', owner_id: 'own', workspace_id: 'ws', title: c.title, type: c.type, position: i })
      expect(columnFromDb(db)).toEqual(c)
    })
    expect(columnToDb(cols[0], 0, meta)).toMatchObject({ options: null, system_type: null, role: null, width: null })
  })
})
