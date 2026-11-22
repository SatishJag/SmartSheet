// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultCalendar } from '../../engine/calendar'
import type { Project } from '../types'
import { findActivityTable, guessProject, mapStatus, parsePredecessors, readActivities, readBasis } from './table'
import { readWorkbook, type Workbook } from './workbook'

const fixture = () =>
  readWorkbook(new File([readFileSync(resolve(__dirname, '__fixtures__/plan-template.xlsx'))], 'Plan template.xlsx'))

const sheet = (rows: string[][], name = 'Plan'): Workbook => ({ fileName: 'plan.xlsx', sheets: [{ name, rows }] })

describe('findActivityTable', () => {
  it('finds the template’s heading row and maps all its columns', async () => {
    const map = findActivityTable(await fixture())!
    expect(map.sheet).toBe('Schedule Template')
    expect(map.headingRow).toBe(6)
    expect(map.fields).toEqual({
      activityId: 0,
      phase: 1,
      name: 2,
      kind: 3,
      responsibility: 4,
      duration: 5,
      start: 6,
      finish: 7,
      status: 9,
      predecessors: 10,
      criteria: 11,
    })
  })

  it('needs a name column and two others', () => {
    expect(findActivityTable(sheet([['Task', 'Duration', 'Predecessors'], ['Dig', '5', '']]))?.fields).toEqual({ name: 0, duration: 1, predecessors: 2 })
    expect(findActivityTable(sheet([['Task', 'Notes'], ['Dig', 'x']]))).toBeNull()
    expect(findActivityTable(sheet([['Alpha', 'Beta', 'Gamma'], ['1', '2', '3']]))).toBeNull()
  })

  it('prefers the sheet with the most mapped columns', () => {
    const wb: Workbook = {
      fileName: 'x.xlsx',
      sheets: [
        { name: 'Short', rows: [['Task', 'Duration', 'Status'], ['A', '1', '']] },
        { name: 'Full', rows: [['Activity ID', 'Activity', 'Duration', 'Predecessors', 'Status'], ['A1', 'A', '1', '', '']] },
      ],
    }
    expect(findActivityTable(wb)?.sheet).toBe('Full')
  })
})

describe('readActivities', () => {
  it('copies the template’s rows exactly', async () => {
    const wb = await fixture()
    const { activities, warnings } = readActivities(wb, findActivityTable(wb)!, defaultCalendar)
    expect(activities.map((a) => a.code)).toEqual(['P010', 'P020', 'P030', 'P035', 'P040', 'P420'])
    expect(activities[0]).toEqual({
      code: 'P010',
      name: 'Define development brief and feasibility',
      phase: '01 Feasibility',
      milestone: false,
      responsibility: 'Development',
      criteria: 'Product mix, viability, funding strategy',
      durationDays: 40,
      durationFrom: 'file',
      links: [],
      hasPredecessors: false,
      status: 'Not started',
    })
    expect(activities[1]).toMatchObject({ milestone: true, durationDays: 0, durationFrom: 'file', links: [{ from: 'P010', type: 'FS', lagDays: 0 }], hasPredecessors: true })
    // Blank duration, but a start and a finish: 20 working days (4 to 29 January 2027, inclusive).
    expect(activities[2]).toMatchObject({ durationDays: 20, durationFrom: 'dates', status: 'In progress', links: [{ from: 'P010', type: 'SS', lagDays: 0 }] })
    expect(activities[3]).toMatchObject({ durationDays: null, durationFrom: null, status: 'Not started', links: [{ from: 'P030', type: 'FS', lagDays: 5 }] })
    expect(activities[4]).toMatchObject({ status: 'Complete', links: [{ from: 'P020', type: 'FS', lagDays: 0 }, { from: 'P030', type: 'FS', lagDays: 0 }] })
    expect(warnings).toEqual([])
  })

  it('generates IDs, renames duplicates, and drops links it cannot follow', () => {
    const wb = sheet([
      ['Activity ID', 'Activity', 'Duration', 'Predecessors'],
      ['', 'First', '5', ''],
      ['X1', 'Second', '3', 'A001 FS; ZZ9 FS; X1 FS'],
      ['X1', 'Third', '2', ''],
      ['', '', '', ''],
      ['X2', '', '4', ''],
    ])
    const { activities, warnings } = readActivities(wb, findActivityTable(wb)!, defaultCalendar)
    expect(activities.map((a) => [a.code, a.name])).toEqual([
      ['A001', 'First'],
      ['X1', 'Second'],
      ['X1-2', 'Third'],
    ])
    expect(activities[1].links).toEqual([{ from: 'A001', type: 'FS', lagDays: 0 }])
    expect(warnings).toEqual([
      'X1 appears more than once; the later row is X1-2.',
      'X1 refers to ZZ9, which is not in the file; that link is left out.',
      'X1 refers to itself; that link is left out.',
    ])
  })

  it('takes up to 500 activities', () => {
    const rows = [['Activity', 'Duration', 'Status'], ...Array.from({ length: 501 }, (_, i) => [`Task ${i}`, '1', ''])]
    const wb = sheet(rows)
    expect(() => readActivities(wb, findActivityTable(wb)!, defaultCalendar)).toThrow('This file has 501 activities; the import takes up to 500.')
  })

  it('warns about statuses it does not know and dates it cannot read', () => {
    const wb = sheet([
      ['Activity', 'Status', 'Start', 'Finish'],
      ['Dig', 'Waiting on client', 'soon', '2027-01-04'],
    ])
    const { activities, warnings } = readActivities(wb, findActivityTable(wb)!, defaultCalendar)
    expect(activities[0]).toMatchObject({ status: 'Not started', durationDays: null })
    expect(warnings).toEqual(['A001: status "Waiting on client" is not one of the sheet’s statuses; it is set to Not started.', 'A001: the start "soon" is not a date; it is ignored.'])
  })
})

describe('parsePredecessors', () => {
  it('reads codes, link types and lags', () => {
    expect(parsePredecessors('P080 FS; P090 SS+5; P100FF-2d')).toEqual([
      { from: 'P080', type: 'FS', lagDays: 0 },
      { from: 'P090', type: 'SS', lagDays: 5 },
      { from: 'P100', type: 'FF', lagDays: -2 },
    ])
    expect(parsePredecessors('P010, P020 sf')).toEqual([
      { from: 'P010', type: 'FS', lagDays: 0 },
      { from: 'P020', type: 'SF', lagDays: 0 },
    ])
  })

  it('treats "Project start" and blanks as no predecessor', () => {
    expect(parsePredecessors('Project start')).toEqual([])
    expect(parsePredecessors('  ')).toEqual([])
  })
})

describe('mapStatus', () => {
  it('maps the template’s words onto the sheet’s statuses', () => {
    expect(mapStatus('To plan')).toEqual({ status: 'Not started' })
    expect(mapStatus('')).toEqual({ status: 'Not started' })
    expect(mapStatus('ongoing')).toEqual({ status: 'In progress' })
    expect(mapStatus('Done')).toEqual({ status: 'Complete' })
    expect(mapStatus('On hold')).toEqual({ status: 'On hold' })
    expect(mapStatus('Waiting')).toEqual({ status: 'Not started', warning: 'status "Waiting" is not one of the sheet’s statuses; it is set to Not started.' })
  })
})

describe('Basis of Plan', () => {
  const PROJECTS: Project[] = [
    { code: 'VIL-01', name: 'Sample villa', isProgram: false, projectType: 'properties', inProcore: false },
    { code: 'BKK-03', name: 'Bangkok 3', isProgram: false, projectType: 'data-centre', inProcore: true },
  ]

  it('reads the project and the handover date', async () => {
    const basis = readBasis(await fixture())
    expect(basis.handoverDate).toBe('2028-06-30')
    expect(basis.projectText).toEqual(expect.arrayContaining(['Sample villa development', 'VIL-01, Plot 12']))
  })

  it('guesses a listed project from the basis, or nothing', async () => {
    const wb = await fixture()
    expect(guessProject(PROJECTS, wb, readBasis(wb))).toBe('VIL-01')
    expect(guessProject(PROJECTS.slice(1), wb, readBasis(wb))).toBe('')
  })

  it('falls back to the file name for the project', () => {
    const wb: Workbook = { fileName: 'BKK-03 LLE plan.xlsx', sheets: [{ name: 'Plan', rows: [['Activity', 'Duration', 'Status']] }] }
    expect(guessProject(PROJECTS, wb, readBasis(wb))).toBe('BKK-03')
  })
})
