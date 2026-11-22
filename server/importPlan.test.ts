// @vitest-environment node
import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import { dcMasterCatalog } from '../src/planner/catalogs/dcMasterCatalog'
import { propertyDevelopmentCatalog } from '../src/planner/catalogs/propertyCatalog'
import type { CatalogActivity, HistorySource, HistorySummary, ImportActivityRef, PlannerOptions } from '../src/planner/types'
import type { AnthropicLike } from './ai'
import { matchScheduleType, parseImportRequest, planImport, mapImportColumns, ESTIMATE_FALLBACK_DAYS } from './importPlan'

type BetaMessage = Anthropic.Beta.Messages.BetaMessage

const PROPERTY = propertyDevelopmentCatalog()
const LLE: CatalogActivity[] = [
  { scheduleType: 'lle-procurement', code: 'SPEC', name: 'Technical specification', phase: 'Engineering', sequence: 1, defaultLinks: [], defaultDays: 10, isTarget: false },
  { scheduleType: 'lle-procurement', code: 'ONSITE', name: 'On site', phase: 'Delivery', sequence: 2, defaultLinks: [{ from: 'SPEC', type: 'FS', lagDays: 0 }], defaultDays: 0, isTarget: true },
]
const OPTIONS: PlannerOptions = {
  scheduleTypes: [
    { id: 'lle-procurement', name: 'Long-lead equipment procurement', description: '' },
    { id: 'property-development', name: 'Property development master schedule', description: '' },
  ],
  equipmentTypes: {},
}
const EMPTY = (scheduleType: string): HistorySummary => ({ scheduleType, equipmentType: null, projectCount: 0, sampleOnly: false, stats: [] })

function source(summary: (type: string) => HistorySummary = EMPTY): HistorySource {
  return {
    options: async () => OPTIONS,
    catalog: async (type) => (type === 'property-development' ? PROPERTY : type === 'lle-procurement' ? LLE : []),
    summary: async (type) => summary(type),
  }
}

function fakeAi(...inputs: unknown[]) {
  const create = vi.fn(async () => {
    const input = inputs.shift()
    if (input instanceof Error) throw input
    return {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_1', name: (input as { __tool?: string }).__tool ?? 'estimate_durations', input }],
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as BetaMessage
  })
  const client: AnthropicLike = { beta: { messages: { create } } }
  return { client, create }
}

const config = (anthropic: AnthropicLike | null) => ({ anthropic, model: 'claude-opus-5-5', aiTimeoutMs: 1000, aiDeadlineMs: 2000, log: () => {} })
const ref = (code: string, name: string, phase: string, hasDuration = false, hasPredecessors = true): ImportActivityRef => ({ code, name, phase, hasDuration, hasPredecessors })
const fromTemplate = (n: number) => PROPERTY.slice(0, n).map((a) => ref(a.code, a.name, a.phase, false, true))

describe('parseImportRequest', () => {
  const hints = { fileName: 'plan.xlsx', sheetNames: ['Plan'] }

  it('accepts either columns or activities, not both or neither', () => {
    expect(parseImportRequest({ hints, activities: [ref('A', 'Dig', '')] }).ok).toBe(true)
    expect(parseImportRequest({ hints, columns: [{ sheet: 'Plan', rows: [['Task']] }] }).ok).toBe(true)
    expect(parseImportRequest({ hints }).ok).toBe(false)
    expect(parseImportRequest({ hints, activities: [], columns: [] }).ok).toBe(false)
  })

  it('refuses more than 500 activities and more than 5 sheets of columns', () => {
    expect(parseImportRequest({ hints, activities: Array.from({ length: 501 }, (_, i) => ref(`A${i}`, 'x', '')) })).toMatchObject({ ok: false })
    expect(parseImportRequest({ hints, columns: Array.from({ length: 6 }, (_, i) => ({ sheet: `S${i}`, rows: [] })) })).toMatchObject({ ok: false })
  })

  it('accepts a chosen schedule type or null, and rejects other shapes', () => {
    expect(parseImportRequest({ hints, activities: [ref('A', 'Dig', '')], scheduleType: null })).toMatchObject({ ok: true, value: { scheduleType: null } })
    expect(parseImportRequest({ hints, activities: [ref('A', 'Dig', '')], scheduleType: 'x' })).toMatchObject({ ok: true, value: { scheduleType: 'x' } })
    expect(parseImportRequest({ hints, activities: [ref('A', 'Dig', '')], scheduleType: 3 }).ok).toBe(false)
    expect(parseImportRequest({ hints, activities: [{ code: 'A' }] }).ok).toBe(false)
  })
})

describe('matchScheduleType', () => {
  it('picks the catalog that covers at least half of the file’s activities, by code or name', () => {
    const catalogs = { 'property-development': PROPERTY, 'lle-procurement': LLE }
    expect(matchScheduleType(catalogs, fromTemplate(44))).toBe('property-development')
    const byName = PROPERTY.slice(0, 10).map((a, i) => ref(`X${i}`, a.name.toUpperCase(), ''))
    expect(matchScheduleType(catalogs, byName)).toBe('property-development')
    expect(matchScheduleType(catalogs, [ref('Z1', 'Unrelated', ''), ref('Z2', 'Other', ''), ref('P010', 'x', '')])).toBeNull()
  })
})

describe('planImport', () => {
  it('detects the template and fills blank durations from it, with links for activities that have none', async () => {
    const acts = [
      ref('P010', 'Define development brief and feasibility', '01 Feasibility', true, false),
      ref('P020', 'Approve development business case', '01 Feasibility', true, false),
      ref('P030', 'Complete land, title and technical due diligence', '02 Land', false, true),
      ref('P420', 'Complete planned handover', '14 Handover', true, true),
    ]
    const result = await planImport(source(), { hints: { fileName: 'p.xlsx', sheetNames: [] }, activities: acts }, config(null))
    expect(result.usedAi).toBe(false)
    expect(result.value).toMatchObject({ scheduleType: 'property-development', targetCode: 'P420', history: { projectCount: 0 } })
    const p030 = PROPERTY.find((a) => a.code === 'P030')!
    expect(result.value.durations).toEqual([{ code: 'P030', days: p030.defaultDays, basis: 'template', reason: 'from the template, no history yet' }])
    // P020 has no predecessors in the file: it gets the template's P010 FS link. P010 has none in the template.
    expect(result.value.templateLinks).toEqual([{ to: 'P020', from: 'P010', type: 'FS', lagDays: 0 }])
  })

  it('uses history medians where there are some', async () => {
    const withStats = (type: string): HistorySummary => ({ ...EMPTY(type), projectCount: 4, stats: [{ code: 'P030', n: 4, p50: 37.4, p80: 50, min: 30, max: 60 }] })
    const result = await planImport(source(withStats), { hints: { fileName: 'p.xlsx', sheetNames: [] }, activities: [ref('P030', 'x', '', false)] }, config(null))
    expect(result.value.durations).toEqual([{ code: 'P030', days: 37, basis: 'history', reason: 'Median (p50) of 4 historical projects.' }])
  })

  it('asks the AI only for blank activities the template does not have, and validates its answer', async () => {
    const acts = [...fromTemplate(4), ref('P035', 'Survey the neighbouring plot', '02 Land', false, true)]
    const ai = fakeAi({ estimates: [{ code: 'P035', days: 12, reason: 'Similar to a site survey.' }] })
    const result = await planImport(source(), { hints: { fileName: 'p.xlsx', sheetNames: [] }, activities: acts }, config(ai.client))
    expect(result.usedAi).toBe(true)
    expect(result.value.durations.find((d) => d.code === 'P035')).toEqual({ code: 'P035', days: 12, basis: 'estimate', reason: 'Similar to a site survey.' })
    const sent = JSON.stringify(ai.create.mock.calls[0])
    expect(sent).toContain('Survey the neighbouring plot')
    expect(sent).not.toContain('Define development brief') // template activities are not sent
  })

  it('falls back to 5 days when the AI answer is unusable or fails', async () => {
    const acts = [ref('Z1', 'Odd task', ''), ref('Z2', 'Other task', '')]
    for (const reply of [{ estimates: [{ code: 'Z1', days: -3, reason: 'x' }] }, new Error('down')]) {
      const ai = fakeAi(reply, reply)
      const result = await planImport(source(), { hints: { fileName: 'p.xlsx', sheetNames: [] }, activities: acts, scheduleType: null }, config(ai.client))
      expect(result.value.durations).toEqual([
        { code: 'Z1', days: ESTIMATE_FALLBACK_DAYS, basis: 'estimate', reason: 'default: no AI estimate available' },
        { code: 'Z2', days: ESTIMATE_FALLBACK_DAYS, basis: 'estimate', reason: 'default: no AI estimate available' },
      ])
      expect(result.value.scheduleType).toBeNull()
    }
  })

  it('uses a schedule type the planner chose, or none', async () => {
    const acts = fromTemplate(3)
    const chosen = await planImport(source(), { hints: { fileName: 'p.xlsx', sheetNames: [] }, activities: acts, scheduleType: 'lle-procurement' }, config(null))
    expect(chosen.value.scheduleType).toBe('lle-procurement')
    expect(chosen.value.durations.every((d) => d.basis === 'estimate')).toBe(true) // none are LLE activities
    await expect(planImport(source(), { hints: { fileName: 'p.xlsx', sheetNames: [] }, activities: acts, scheduleType: 'nope' }, config(null))).rejects.toThrow('Unknown schedule type: nope.')
  })
})

describe('mapImportColumns', () => {
  const columns = [{ sheet: 'Plan', rows: [['Ref', 'What', 'Days', 'After'], ['1', 'Dig', '5', '']] }]
  const req = { hints: { fileName: 'p.xlsx', sheetNames: ['Plan'] }, columns }

  it('returns the AI’s mapping when it is valid', async () => {
    const ai = fakeAi({ __tool: 'map_columns', found: true, sheet: 'Plan', headingRow: 0, fields: { activityId: 0, name: 1, duration: 2, predecessors: 3 } })
    const result = await mapImportColumns(req, config(ai.client))
    expect(result).toEqual({ usedAi: true, mapping: { sheet: 'Plan', headingRow: 0, fields: { activityId: 0, name: 1, duration: 2, predecessors: 3 } } })
  })

  it('returns null when the AI finds nothing, names an unknown sheet, or is not configured', async () => {
    expect((await mapImportColumns(req, config(fakeAi({ __tool: 'map_columns', found: false }).client))).mapping).toBeNull()
    expect((await mapImportColumns(req, config(fakeAi({ __tool: 'map_columns', found: true, sheet: 'Other', headingRow: 0, fields: { name: 1 } }).client))).mapping).toBeNull()
    expect((await mapImportColumns(req, config(fakeAi({ __tool: 'map_columns', found: true, sheet: 'Plan', headingRow: 0, fields: { duration: 2 } }).client))).mapping).toBeNull()
    expect(await mapImportColumns(req, config(null))).toEqual({ usedAi: false, mapping: null })
  })
})

describe('planImport: review fixes', () => {
  it('applies the template to activities matched by name when the file’s IDs differ', async () => {
    const acts = PROPERTY.map((a, i) => ref(`A${String(i + 1).padStart(3, '0')}`, a.name, a.phase, a.defaultDays === 0, false))
    const result = await planImport(source(), { hints: { fileName: 'p.csv', sheetNames: [] }, activities: acts }, config(null))
    expect(result.value.scheduleType).toBe('property-development')
    expect(result.usedAi).toBe(false)
    const p420 = PROPERTY.findIndex((a) => a.code === 'P420')
    expect(result.value.targetCode).toBe(`A${String(p420 + 1).padStart(3, '0')}`)
    expect(result.value.durations.every((d) => d.basis === 'template')).toBe(true)
    // P020's template link P010 FS becomes A002 <- A001.
    expect(result.value.templateLinks).toContainEqual({ to: 'A002', from: 'A001', type: 'FS', lagDays: 0 })
  })

  it('keeps the valid AI estimates and falls back only for the invalid ones, with a cap on days', async () => {
    const acts = [ref('B', 'Task B', ''), ref('C', 'Task C', ''), ref('D', 'Task D', '')]
    const ai = fakeAi({ estimates: [{ code: 'B', days: 3, reason: 'ok' }, { code: 'C', days: -2, reason: 'bad' }, { code: 'D', days: 200000, reason: 'huge' }] })
    const result = await planImport(source(), { hints: { fileName: 'p.xlsx', sheetNames: [] }, activities: acts, scheduleType: null }, config(ai.client))
    expect(result.value.durations).toEqual([
      { code: 'B', days: 3, basis: 'estimate', reason: 'ok' },
      { code: 'C', days: ESTIMATE_FALLBACK_DAYS, basis: 'estimate', reason: 'default: no AI estimate available' },
      { code: 'D', days: ESTIMATE_FALLBACK_DAYS, basis: 'estimate', reason: 'default: no AI estimate available' },
    ])
  })

  it('gives the AI room to answer for many activities', async () => {
    const acts = Array.from({ length: 400 }, (_, i) => ref(`Z${i}`, `Task ${i}`, ''))
    const ai = fakeAi({ estimates: [] })
    await planImport(source(), { hints: { fileName: 'p.xlsx', sheetNames: [] }, activities: acts, scheduleType: null }, config(ai.client))
    const body = (ai.create.mock.calls[0] as unknown as [{ max_tokens: number }])[0]
    expect(body.max_tokens).toBeGreaterThanOrEqual(400 * 40)
  })
})

describe('import: the Data centre master is not an import template (PR review)', () => {
  const DC = dcMasterCatalog()
  const withDc: HistorySource = {
    options: async () => ({ ...OPTIONS, scheduleTypes: [...OPTIONS.scheduleTypes, { id: 'dc-master', name: 'Data centre master schedule', description: '' }] }),
    catalog: async (type) => (type === 'dc-master' ? DC : type === 'property-development' ? PROPERTY : type === 'lle-procurement' ? LLE : []),
    summary: async (type) => EMPTY(type),
  }
  const config = { anthropic: null, model: 'm', aiTimeoutMs: 1000, aiDeadlineMs: 1000, log: () => {} }
  // Activities named exactly as the Data centre template's, so they would match it by name.
  const acts: ImportActivityRef[] = DC.slice(185, 199).map((a) => ({ code: a.activityId!, name: a.name, phase: a.phase, hasDuration: false, hasPredecessors: false }))

  it('never matches a file to the Data centre master', async () => {
    const { value } = await planImport(withDc, { hints: { fileName: 'dc.xlsx', sheetNames: [] }, activities: acts }, config)
    expect(value.scheduleType).toBeNull()
    expect(value.templateLinks).toEqual([])
  })

  it('refuses the Data centre master as the chosen template', async () => {
    await expect(planImport(withDc, { hints: { fileName: 'dc.xlsx', sheetNames: [] }, activities: acts, scheduleType: 'dc-master' }, config)).rejects.toMatchObject({
      status: 400,
      message: 'The Data centre master schedule cannot be used to import a plan; choose another schedule type or a general schedule.',
    })
  })
})
