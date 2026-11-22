import { describe, expect, it } from 'vitest'
import { defaultCalendar } from '../../engine/calendar'
import { basisText } from '../sheetFromDraft'
import type { ImportActivitiesResult } from '../types'
import { buildImportDraft, scheduleImport } from './importDraft'
import type { ImportedActivity } from './table'

const TODAY = '2026-11-23'

const act = (code: string, extra: Partial<ImportedActivity> = {}): ImportedActivity => ({
  code,
  name: `Activity ${code}`,
  phase: 'Stage',
  milestone: false,
  durationDays: null,
  durationFrom: null,
  links: [],
  hasPredecessors: false,
  status: 'Not started',
  ...extra,
})

const ACTS: ImportedActivity[] = [
  act('P010', { durationDays: 40, durationFrom: 'file', responsibility: 'Development', criteria: 'Brief agreed' }),
  act('P020', { milestone: true, durationDays: 0, durationFrom: 'file' }),
  act('P030', { durationDays: 20, durationFrom: 'dates', links: [{ from: 'P010', type: 'SS', lagDays: 0 }], hasPredecessors: true, status: 'In progress' }),
  act('P035', { links: [{ from: 'P030', type: 'FS', lagDays: 5 }], hasPredecessors: true }),
  act('P040', { links: [{ from: 'P020', type: 'FS', lagDays: 0 }, { from: 'P030', type: 'FS', lagDays: 0 }], hasPredecessors: true, milestone: true, durationDays: 0, durationFrom: 'file' }),
  act('P420', { milestone: true, durationDays: 0, durationFrom: 'file', links: [{ from: 'P040', type: 'FS', lagDays: 0 }, { from: 'P035', type: 'FS', lagDays: 0 }], hasPredecessors: true }),
]

const SERVER: ImportActivitiesResult = {
  scheduleType: 'property-development',
  targetCode: 'P420',
  durations: [{ code: 'P035', days: 12, basis: 'estimate', reason: 'Similar to a site survey.' }],
  templateLinks: [{ to: 'P020', from: 'P010', type: 'FS', lagDays: 0 }],
  history: { scheduleType: 'property-development', equipmentType: null, projectCount: 0, sampleOnly: false, stats: [] },
}

const build = (activities = ACTS, server: ImportActivitiesResult = SERVER) =>
  buildImportDraft({ activities, server, scheduleType: server.scheduleType, projectName: 'Sample villa', requiredDate: '2028-06-30', fileName: 'plan.xlsx' })

describe('buildImportDraft', () => {
  it('keeps the file’s activities, IDs and links exactly, adding only durations and template links', () => {
    const { draft, counts } = build()
    expect(draft.activities.map((a) => [a.code, a.name, a.phase, a.durationDays])).toEqual([
      ['P010', 'Activity P010', 'Stage', 40],
      ['P020', 'Activity P020', 'Stage', 0],
      ['P030', 'Activity P030', 'Stage', 20],
      ['P035', 'Activity P035', 'Stage', 12],
      ['P040', 'Activity P040', 'Stage', 0],
      ['P420', 'Activity P420', 'Stage', 0],
    ])
    expect(draft.activities[0]).toMatchObject({ activityId: 'P010', responsibility: 'Development', criteria: 'Brief agreed', status: 'Not started' })
    expect(draft.activities[2].status).toBe('In progress')
    expect(draft.links).toEqual([
      { from: 'P010', to: 'P030', type: 'SS', lagDays: 0 },
      { from: 'P030', to: 'P035', type: 'FS', lagDays: 5 },
      { from: 'P020', to: 'P040', type: 'FS', lagDays: 0 },
      { from: 'P030', to: 'P040', type: 'FS', lagDays: 0 },
      { from: 'P040', to: 'P420', type: 'FS', lagDays: 0 },
      { from: 'P035', to: 'P420', type: 'FS', lagDays: 0 },
      { from: 'P010', to: 'P020', type: 'FS', lagDays: 0 },
    ])
    expect(draft.targetCode).toBe('P420')
    expect(draft.request).toEqual({ scheduleType: 'property-development', equipmentType: '', equipmentName: 'Sample villa', requiredDate: '2028-06-30' })
    expect(counts).toEqual({ fromFile: 5, filled: 1 })
  })

  it('says where each duration came from', () => {
    const { draft } = build()
    const basis = (code: string) => basisText(draft.activities.find((a) => a.code === code)!, draft.history)
    expect(basis('P010')).toBe('from your file')
    expect(basis('P030')).toBe('from your file’s dates')
    expect(basis('P035')).toBe('AI estimate: Similar to a site survey.')
    expect(basis('P020')).toBe('from your file; links from the template')
  })

  it('shows template, history and fallback durations as such', () => {
    const acts = [act('A'), act('B', { links: [{ from: 'A', type: 'FS', lagDays: 0 }], hasPredecessors: true }), act('C', { links: [{ from: 'B', type: 'FS', lagDays: 0 }], hasPredecessors: true })]
    const server: ImportActivitiesResult = {
      ...SERVER,
      targetCode: null,
      templateLinks: [],
      durations: [
        { code: 'A', days: 10, basis: 'template', reason: 'from the template, no history yet' },
        { code: 'B', days: 7, basis: 'history', reason: 'Median (p50) of 4 historical projects.' },
        { code: 'C', days: 5, basis: 'estimate', reason: 'default: no AI estimate available' },
      ],
      history: { ...SERVER.history!, projectCount: 4, stats: [{ code: 'B', n: 4, p50: 7, p80: 9, min: 5, max: 12 }] },
    }
    const { draft } = build(acts, server)
    const basis = draft.activities.map((a) => basisText(a, draft.history))
    expect(basis).toEqual(['from the template, no history yet', 'p50 of 4 projects', 'default: no AI estimate available'])
    expect(draft.targetCode).toBe('C') // the only activity without successors
  })

  it('warns about activities the plan cannot link, and about a plan with no links at all', () => {
    const lone = [act('A', { durationDays: 3, durationFrom: 'file' }), act('B', { durationDays: 4, durationFrom: 'file' })]
    const { warnings, draft } = build(lone, { ...SERVER, scheduleType: null, targetCode: null, templateLinks: [], durations: [], history: null })
    expect(warnings).toContain('No predecessors found: the dates are not meaningful until links are added.')
    expect(warnings).toContain('B has no predecessors; it starts with the plan.')
    expect(draft.targetCode).toBe('B') // several activities without successors: the last row
    expect(draft.request.scheduleType).toBe('imported')
    expect(draft.history).toMatchObject({ projectCount: 0, stats: [] })
  })
})

describe('scheduleImport', () => {
  it('plans the import backward from the handover date', () => {
    const result = scheduleImport(build().draft, defaultCalendar, TODAY)
    expect('plan' in result && result.plan.projectEnd).toBe('2028-06-30')
  })

  it('turns a cycle into an error, not a crash', () => {
    const cyclic = [
      act('A', { durationDays: 2, durationFrom: 'file', links: [{ from: 'B', type: 'FS', lagDays: 0 }], hasPredecessors: true }),
      act('B', { durationDays: 2, durationFrom: 'file', links: [{ from: 'A', type: 'FS', lagDays: 0 }], hasPredecessors: true }),
    ]
    const { draft } = build(cyclic, { ...SERVER, scheduleType: null, targetCode: null, templateLinks: [], durations: [], history: null })
    const result = scheduleImport(draft, defaultCalendar, TODAY)
    expect(result).toEqual({ error: expect.stringMatching(/^The plan cannot be scheduled: /) })
  })
})

describe('buildImportDraft: fallback estimates', () => {
  it('says how many durations could not be estimated', () => {
    const acts = [act('A', { durationDays: 2, durationFrom: 'file' }), act('B', { links: [{ from: 'A', type: 'FS', lagDays: 0 }], hasPredecessors: true }), act('C', { links: [{ from: 'B', type: 'FS', lagDays: 0 }], hasPredecessors: true })]
    const server: ImportActivitiesResult = {
      ...SERVER,
      targetCode: null,
      templateLinks: [],
      durations: [
        { code: 'B', days: 5, basis: 'estimate', reason: 'default: no AI estimate available' },
        { code: 'C', days: 5, basis: 'estimate', reason: 'default: no AI estimate available' },
      ],
    }
    expect(build(acts, server).warnings).toContain('2 durations could not be estimated; they are set to 5 days. Check them in Basis.')
  })
})

describe('buildImportDraft: links the sheet cannot hold', () => {
  it('keeps one of two different links between the same pair, and says so', () => {
    const acts = [
      act('A', { durationDays: 8, durationFrom: 'file' }),
      act('B', { durationDays: 3, durationFrom: 'file', links: [{ from: 'A', type: 'SS', lagDays: 0 }, { from: 'A', type: 'FF', lagDays: 0 }], hasPredecessors: true }),
    ]
    const { draft, warnings } = build(acts, { ...SERVER, scheduleType: null, targetCode: null, templateLinks: [], durations: [], history: null })
    expect(draft.links).toEqual([{ from: 'A', to: 'B', type: 'SS', lagDays: 0 }])
    expect(warnings).toContain('B has two links from A (SS and FF); a schedule holds one link per pair, so only SS is kept.')
  })

  it('leaves out a template link that would close a loop with the file’s links', () => {
    // The file says P010 follows P020; the template would add P020 after P010.
    const acts = [
      act('P020', { durationDays: 2, durationFrom: 'file' }),
      act('P010', { durationDays: 2, durationFrom: 'file', links: [{ from: 'P020', type: 'FS', lagDays: 0 }], hasPredecessors: true }),
    ]
    const server: ImportActivitiesResult = { ...SERVER, targetCode: null, durations: [], templateLinks: [{ to: 'P020', from: 'P010', type: 'FS', lagDays: 0 }] }
    const { draft, warnings } = build(acts, server)
    expect(draft.links).toEqual([{ from: 'P020', to: 'P010', type: 'FS', lagDays: 0 }])
    expect(draft.activities.find((a) => a.code === 'P020')?.linksFromTemplate).toBeUndefined()
    expect(warnings).toContain('The template link P010 → P020 is left out: it would make a loop with the links in your file.')
    expect(scheduleImport(draft, defaultCalendar, TODAY)).toHaveProperty('plan')
  })
})
