// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildUserPrompt } from '../../../server/ai'
import { withCatalogDetails } from '../../../server/planner'
import { defaultCalendar } from '../../engine/calendar'
import { planBackward } from '../backward'
import { buildHistoryDraft } from '../historyDraft'
import { ACTIVITY_ID_COLUMN_TITLE, buildSheetFromDraft, CRITERIA_COLUMN_TITLE, RESPONSIBILITY_COLUMN_TITLE, sheetNameForDraft } from '../sheetFromDraft'
import type { HistorySummary, PlanRequest } from '../types'
import { afterTargetCodes, validateDraft } from '../validateDraft'
import { propertyDevelopmentCatalog } from './propertyCatalog'
import { PROPERTY_DEVELOPMENT_ACTIVITIES as A, PROPERTY_DEVELOPMENT_BASIS, PROPERTY_DEVELOPMENT_TYPE as T } from './propertyDevelopment'

const propertyCatalog = propertyDevelopmentCatalog

const REQUEST: PlanRequest = { scheduleType: T.id, equipmentType: 'Residential tower', equipmentName: 'Marina Heights, 2 towers, 450 units', requiredDate: '2031-06-30' }
const NO_HISTORY: HistorySummary = { scheduleType: T.id, equipmentType: null, projectCount: 0, sampleOnly: false, stats: [] }

describe('the property development template', () => {
  it('is the template: 44 activities in 15 stages, ids P010..P440, 16 control gates', () => {
    expect(A).toHaveLength(44)
    expect(A.map((a) => a.id)).toEqual(Array.from({ length: 44 }, (_, i) => `P${String((i + 1) * 10).padStart(3, '0')}`))
    expect(new Set(A.map((a) => a.stage)).size).toBe(15)
    expect(A[0].stage).toBe('01 Feasibility')
    expect(A.at(-1)!.stage).toBe('15 Defects and close-out')
    expect(A.filter((a) => a.milestone)).toHaveLength(16)
    expect(A.find((a) => a.id === 'P120')).toMatchObject({
      name: 'Obtain enabling and main works permits',
      responsibility: 'Consultant / Authorities',
      links: [
        { from: 'P090', type: 'SS', lagDays: 0 },
        { from: 'P110', type: 'FS', lagDays: 0 },
      ],
    })
  })

  it('links only to earlier activities; milestones take 0 days, activities more', () => {
    const seen = new Set<string>()
    for (const a of A) {
      for (const l of a.links) expect(seen.has(l.from), `${a.id} <- ${l.from}`).toBe(true)
      seen.add(a.id)
      if (a.milestone) expect(a.defaultDays).toBe(0)
      else expect(a.defaultDays).toBeGreaterThan(0)
    }
  })

  it('targets handover; only the defects period and close-out stay outside its logic', () => {
    expect(T.targetId).toBe('P420')
    expect([...afterTargetCodes(propertyCatalog())].sort()).toEqual(['P430', 'P440'])
  })

  it('drafts a valid plan from the catalog alone and plans it back from the handover date', () => {
    const catalog = propertyCatalog()
    const draft = withCatalogDetails(buildHistoryDraft({ request: REQUEST, catalog, history: NO_HISTORY, assumptions: [] }), catalog)
    expect(validateDraft(draft, { catalog, stats: [] }).ok).toBe(true)
    expect(draft.activities).toHaveLength(44)
    expect(draft.links).toHaveLength(A.reduce((n, a) => n + a.links.length, 0))
    const plan = planBackward(draft, defaultCalendar, '2026-11-20')
    const byCode = new Map(plan.activities.map((a) => [a.code, a]))
    expect(byCode.get('P420')!.end).toBe('2031-06-30') // handover lands on the date asked for (a Monday)
    expect(byCode.get('P440')!.start > '2031-06-30').toBe(true) // close-out after handover
    expect(plan.projectEnd > '2032-01-01').toBe(true)
    expect(byCode.get('P010')!.start).toBe('2028-02-01') // about 3.4 years before handover with the placeholder durations
    expect(plan.feasibility.feasible).toBe(true)

    const sheet = buildSheetFromDraft(draft, plan, 'owner-1', defaultCalendar)
    expect(sheetNameForDraft(draft)).toBe('Programme – Marina Heights, 2 towers, 450 units')
    const titles = sheet.columns.map((c) => c.title)
    expect(titles.slice(0, 2)).toEqual(['Task', ACTIVITY_ID_COLUMN_TITLE])
    expect(titles.slice(-3)).toEqual([RESPONSIBILITY_COLUMN_TITLE, CRITERIA_COLUMN_TITLE, 'Basis'])
    const col = (t: string) => sheet.columns.find((c) => c.title === t)!.id
    const permits = sheet.rows.find((r) => r.cells[col('Task')] === 'Obtain enabling and main works permits')!
    expect(permits.cells[col(ACTIVITY_ID_COLUMN_TITLE)]).toBe('P120')
    expect(permits.cells[col(RESPONSIBILITY_COLUMN_TITLE)]).toBe('Consultant / Authorities')
    expect(permits.cells[col(CRITERIA_COLUMN_TITLE)]).toBe('Package permits issued before the relevant site works')
    expect(permits.cells[col('Phase')]).toBe('05 Authorities and permits')
    expect(sheet.dependencies).toHaveLength(draft.links.length)
  })

  it('refuses an activity that follows the target unless the catalog places it there', () => {
    const catalog = propertyCatalog()
    const draft = buildHistoryDraft({ request: REQUEST, catalog, history: NO_HISTORY, assumptions: [] })
    const bad = { ...draft, links: [...draft.links, { from: 'P420', to: 'P410', type: 'FS' as const, lagDays: 0 }] }
    const res = validateDraft(bad, { catalog, stats: [] })
    expect(res.ok).toBe(false)
    const detached = { ...draft, links: draft.links.filter((l) => l.to !== 'P430') }
    const res2 = validateDraft(detached, { catalog, stats: [] })
    expect(res2.ok).toBe(false)
    if (!res2.ok) expect(res2.errors.join(' ')).toMatch(/P430 comes after the target P420 in the catalog; link it to its predecessors/)
  })

  it('gives the AI the template: responsibilities, criteria, after-target marks and the basis of plan', () => {
    const prompt = buildUserPrompt({ request: REQUEST, scheduleTypeName: T.name, catalog: propertyCatalog(), history: NO_HISTORY })
    expect(prompt).toContain('"responsibility": "Main Contractor / Consultant"')
    expect(prompt).toContain('"completionCriteria": "Executed main contract and authority to commence"')
    expect(prompt).toMatch(/"code": "P430",[\s\S]*?"afterTarget": true/)
    expect(prompt).toContain('<planning_guidance>')
    expect(prompt).toContain(`- Permits and early works: ${PROPERTY_DEVELOPMENT_BASIS.find((b) => b.rule === 'Permits and early works')!.guidance}`)
    expect(prompt).toContain('its finish must land on 2031-06-30')
  })
})
