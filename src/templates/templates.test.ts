import { render, screen } from '@testing-library/react'
import { createElement, type ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { SheetStoreProvider } from '../store/SheetStoreContext'
import { makeTestStore } from '../test/fixtures'
import { GanttView } from '../views/gantt/GanttView'
import { GridView } from '../views/grid/GridView'
import { KanbanView } from '../views/kanban/KanbanView'
import { createSheetFromTemplate, TEMPLATES } from './index'
import { STATUS_OPTIONS, TRADE_OPTIONS } from './presets'
import { projectScheduleTemplate } from './projectSchedule'
import { punchListTemplate } from './punchList'
import { simpleListTemplate } from './simpleList'

const summarize = (cols: { title: string; type: string; role?: string }[]) =>
  cols.map((c) => [c.title, c.type, c.role ?? null])

const CAL = { workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 }

describe('presets', () => {
  it('has the exact trade and status lists', () => {
    expect([...TRADE_OPTIONS]).toEqual([
      'Concrete',
      'Framing',
      'Electrical',
      'Plumbing',
      'HVAC',
      'Roofing',
      'Drywall',
      'Painting',
      'Flooring',
      'Landscaping',
      'General',
    ])
    expect([...STATUS_OPTIONS]).toEqual(['Not started', 'In progress', 'On hold', 'Complete'])
  })
})

describe('project schedule template', () => {
  it('has the decided columns in order', () => {
    expect(summarize(projectScheduleTemplate.columns)).toEqual([
      ['Task', 'TEXT_NUMBER', null],
      ['Phase', 'TEXT_NUMBER', null],
      ['Trade', 'PICKLIST', null],
      ['Duration', 'DURATION', 'duration'],
      ['Start', 'DATE', 'start'],
      ['End', 'DATE', 'end'],
      ['Predecessors', 'PREDECESSOR', 'predecessor'],
      ['Status', 'PICKLIST', 'status'],
      ['% Complete', 'TEXT_NUMBER', 'percentComplete'],
    ])
    const byTitle = (t: string) => projectScheduleTemplate.columns.find((c) => c.title === t)!
    expect(byTitle('Trade').options).toEqual([...TRADE_OPTIONS])
    expect(byTitle('Status').options).toEqual([...STATUS_OPTIONS])
    expect(projectScheduleTemplate.dependenciesEnabled).toBe(true)
    expect(projectScheduleTemplate.calendar).toEqual(CAL)
  })

  it('status options are a copy of the preset', () => {
    const status = projectScheduleTemplate.columns.find((c) => c.title === 'Status')!
    expect(status.options).not.toBe(STATUS_OPTIONS)
    status.options!.push('Mutated')
    expect([...STATUS_OPTIONS]).toEqual(['Not started', 'In progress', 'On hold', 'Complete'])
    status.options!.pop()
  })
})

describe('punch list template', () => {
  it('has the decided columns in order, without scheduling roles', () => {
    expect(summarize(punchListTemplate.columns)).toEqual([
      ['Item', 'TEXT_NUMBER', null],
      ['Location', 'TEXT_NUMBER', null],
      ['Trade', 'PICKLIST', null],
      ['Assigned To', 'CONTACT_LIST', null],
      ['Status', 'PICKLIST', 'status'],
      ['Due Date', 'DATE', null],
    ])
    expect(punchListTemplate.columns.find((c) => c.title === 'Trade')!.options).toEqual([...TRADE_OPTIONS])
    expect(punchListTemplate.columns.find((c) => c.title === 'Status')!.options).toEqual([...STATUS_OPTIONS])
    expect(punchListTemplate.dependenciesEnabled).toBe(false)
    const roles = ['start', 'end', 'duration', 'predecessor', 'percentComplete']
    expect(punchListTemplate.columns.some((c) => c.role && roles.includes(c.role))).toBe(false)
    expect(punchListTemplate.calendar).toEqual(CAL)
  })
})

describe('simple list template', () => {
  it('has Task, Status (status role) and Notes, and no dependencies', () => {
    expect(summarize(simpleListTemplate.columns)).toEqual([
      ['Task', 'TEXT_NUMBER', null],
      ['Status', 'PICKLIST', 'status'],
      ['Notes', 'TEXT_NUMBER', null],
    ])
    expect(simpleListTemplate.name).toBe('Simple list')
    expect(simpleListTemplate.columns[1].options).toEqual([...STATUS_OPTIONS])
    expect(simpleListTemplate.dependenciesEnabled).toBe(false)
    expect(simpleListTemplate.calendar).toEqual(CAL)
  })
})

describe('TEMPLATES and createSheetFromTemplate', () => {
  it('lists the three templates for the UI, Project schedule first', () => {
    expect(TEMPLATES.map((t) => [t.id, t.name])).toEqual([
      ['project-schedule', 'Project schedule'],
      ['punch-list', 'Punch list'],
      ['simple-list', 'Simple list'],
    ])
    expect(TEMPLATES.every((t) => t.description.length > 0)).toBe(true)
  })

  it.each(['project-schedule', 'punch-list', 'simple-list'] as const)('builds a full SheetData for %s', (id) => {
    const d = createSheetFromTemplate(id, 'user-1')
    expect(d.sheet.ownerId).toBe('user-1')
    expect(d.sheet.workspaceId).toBe('user-1')
    expect(d.sheet.name).toBe(TEMPLATES.find((t) => t.id === id)!.name)
    expect(d.rows).toEqual([])
    expect(d.dependencies).toEqual([])
    expect(d.sheet.dependenciesEnabled).toBe(id === 'project-schedule')
  })

  it('returns fresh ids each call and does not share state with the template', () => {
    const a = createSheetFromTemplate('project-schedule', 'u')
    const b = createSheetFromTemplate('project-schedule', 'u')
    const ids = [a.sheet.id, b.sheet.id, ...a.columns.map((c) => c.id), ...b.columns.map((c) => c.id)]
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(2 + 18)
    a.columns[7].options!.push('Mutated')
    a.sheet.calendar.workingWeekdays.push(6)
    const c = createSheetFromTemplate('project-schedule', 'u')
    expect(c.columns[7].options).toEqual([...STATUS_OPTIONS])
    expect(c.sheet.calendar.workingWeekdays).toEqual([1, 2, 3, 4, 5])
  })

  it('throws on an unknown template id', () => {
    expect(() => createSheetFromTemplate('nope' as never, 'u')).toThrow(/nope/)
  })
})

async function mount(id: 'project-schedule' | 'punch-list' | 'simple-list', view: () => ReactElement) {
  const { store } = await makeTestStore(createSheetFromTemplate(id, 'u'))
  render(createElement(SheetStoreProvider, { store, children: view() }))
}

describe('views over the templates', () => {
  it.each(['project-schedule', 'punch-list', 'simple-list'] as const)('Kanban groups %s by the Status column', async (id) => {
    await mount(id, () => createElement(KanbanView))
    expect(screen.getByLabelText('Group by')).toHaveDisplayValue('Status')
    expect(screen.getAllByRole('region')).toHaveLength(STATUS_OPTIONS.length + 1)
    for (const name of [...STATUS_OPTIONS, 'No status']) {
      expect(screen.getByRole('region', { name: `${name} (0)` })).toBeInTheDocument()
    }
  })

  it('Gantt shows the empty state for a fresh schedule template', async () => {
    await mount('project-schedule', () => createElement(GanttView, { viewportHeight: 600, today: '2026-01-01' }))
    expect(screen.getByText('No scheduled tasks to display')).toBeInTheDocument()
  })

  it.each([
    ['project-schedule', ['Task', 'Phase', 'Trade', 'Duration', 'Start', 'End', 'Predecessors', 'Status', '% Complete']],
    ['punch-list', ['Item', 'Location', 'Trade', 'Assigned To', 'Status', 'Due Date']],
    ['simple-list', ['Task', 'Status', 'Notes']],
  ] as const)('grid renders the %s headers', async (id, titles) => {
    await mount(id, () => createElement(GridView, { viewportHeight: 600 }))
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    for (const t of titles) expect(headers).toContain(t)
  })
})
