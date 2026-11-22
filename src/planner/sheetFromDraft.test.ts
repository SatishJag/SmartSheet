import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { addUser, createFakeSupabase, emptyState, FAKE_STORAGE_KEY, type StorageLike } from '../../e2e/support/fakeSupabase'
import { defaultCalendar } from '../engine/calendar'
import { formatPredecessors } from '../engine/predecessor'
import { schedule } from '../engine/schedule'
import { supabasePersistence } from '../store/persistence'
import { toSchedInput } from '../store/scheduleInput'
import { activity, catalogDraft, link, lleDraft, makeDraft, sampleHistory } from '../test/plannerFixtures'
import { planBackward } from './backward'
import {
  basisText,
  buildSheetFromDraft,
  buildSheetFromDrafts,
  type CostCodeColumn,
  type DeliverySiteColumn,
  PROJECT_COLUMN_TITLE,
  type ProjectColumn,
  insertSheetFromDraft,
  insertSheetFromDrafts,
  itemRowName,
  sheetNameForDraft,
  sheetNameForDrafts,
} from './sheetFromDraft'

const TODAY = '2026-11-14'
const cal = defaultCalendar

describe('sheetNameForDraft', () => {
  it('prefixes LLE drafts and falls back to "Plan"', () => {
    expect(sheetNameForDraft(lleDraft())).toBe('LLE – 400 MVA transformer')
    const other = lleDraft()
    other.request = { ...other.request, scheduleType: 'commissioning' }
    expect(sheetNameForDraft(other)).toBe('Plan – 400 MVA transformer')
  })

  it('uses the equipment type when the name is blank, and keeps within 100 characters', () => {
    const blank = lleDraft()
    blank.request = { ...blank.request, equipmentName: '  ' }
    expect(sheetNameForDraft(blank)).toBe('LLE – Power transformer')
    const long = lleDraft()
    long.request = { ...long.request, equipmentName: 'x'.repeat(200) }
    expect(sheetNameForDraft(long)).toHaveLength(100)
  })
})

describe('basisText', () => {
  const history = sampleHistory({ projectCount: 9, stats: [{ code: 'FAB', n: 7, p50: 90, p80: 110, min: 80, max: 140 }] })
  it('cites the statistic and the number of projects behind it', () => {
    expect(basisText(activity('FAB', 110, { basis: 'p80' }), history)).toBe('p80 of 7 projects')
    expect(basisText(activity('OTHER', 5, { basis: 'p50' }), history)).toBe('p50 of 9 projects')
    expect(basisText(activity('ONE', 5, { basis: 'p50' }), sampleHistory({ projectCount: 1 }))).toBe('p50 of 1 project')
    expect(basisText(activity('NONE', 5, { basis: 'p50' }), sampleHistory({ projectCount: 0 }))).toBe('p50')
  })
  it('marks defaults, adjustments and sample data', () => {
    expect(basisText(activity('X', 5, { basis: 'default' }), history)).toBe('default (no history)')
    expect(basisText(activity('X', 5, { basis: 'adjusted', reason: 'Raised for winter shipping.' }), history)).toBe(
      'adjusted: Raised for winter shipping.',
    )
    expect(basisText(activity('FAB', 110, { basis: 'p80' }), { ...history, sampleOnly: true })).toBe('p80 of 7 projects (sample data)')
  })
})

describe('buildSheetFromDraft', () => {
  const draft = lleDraft('2027-06-30')
  const plan = planBackward(draft, cal, TODAY)
  const data = buildSheetFromDraft(draft, plan, 'user-1', cal)
  const col = (title: string) => data.columns.find((c) => c.title === title)!.id

  it('uses the Project schedule columns plus a Basis text column, with dependencies on', () => {
    expect(data.columns.map((c) => c.title)).toEqual([
      'Task',
      'Phase',
      'Trade',
      'Duration',
      'Start',
      'End',
      'Predecessors',
      'Status',
      '% Complete',
      'Basis',
    ])
    expect(data.columns.at(-1)).toMatchObject({ type: 'TEXT_NUMBER' })
    expect(data.sheet).toMatchObject({ name: 'LLE – 400 MVA transformer', ownerId: 'user-1', workspaceId: 'user-1', dependenciesEnabled: true })
    expect(data.sheet.calendar).toEqual(cal)
  })

  it('one top-level row per activity, in draft order, with Start only where there is no predecessor', () => {
    expect(data.rows).toHaveLength(draft.activities.length)
    const positions = data.rows.map((r) => r.position)
    expect([...positions].sort()).toEqual(positions)
    expect(new Set(positions).size).toBe(positions.length)
    data.rows.forEach((r, i) => {
      const a = draft.activities[i]
      expect(r.parentId).toBeNull()
      expect(r.cells[col('Task')]).toBe(a.name)
      expect(r.cells[col('Phase')]).toBe(a.phase)
      expect(r.cells[col('Duration')]).toBe(`${a.durationDays}d`)
      expect(r.cells[col('Status')]).toBe('Not started')
      expect(typeof r.cells[col('Basis')]).toBe('string')
    })
    const withStart = data.rows.filter((r) => col('Start') in r.cells)
    expect(withStart).toHaveLength(1)
    expect(withStart[0].cells[col('Start')]).toBe(plan.mustStartBy)
    expect(data.rows[5].cells[col('Basis')]).toBe('adjusted: Raised from p80 110 days for the requested conservatism.')
  })

  it('a link becomes a dependency between the rows, its lag in minutes', () => {
    const rowOf = (code: string) => data.rows[draft.activities.findIndex((a) => a.code === code)].id
    expect(data.dependencies).toHaveLength(draft.links.length)
    expect(data.dependencies).toContainEqual({ predecessorId: rowOf('EVAL'), successorId: rowOf('PO'), type: 'FS', lagMinutes: 2 * 8 * 60 })
    expect(data.dependencies).toContainEqual({ predecessorId: rowOf('DWG'), successorId: rowOf('FAB'), type: 'SS', lagMinutes: 10 * 8 * 60 })
    expect(data.dependencies).toContainEqual({ predecessorId: rowOf('FAB'), successorId: rowOf('SHIP'), type: 'FS', lagMinutes: -2 * 8 * 60 })
  })

  it('the sheet schedules to exactly the dates of the preview', () => {
    const input = toSchedInput(data)!
    const result = schedule(input.rows, input.deps, input.calendar)
    expect(result.errors).toEqual([])
    data.rows.forEach((r, i) => {
      const p = plan.activities[i]
      expect(result.byRow[r.id]).toMatchObject({ start: p.start, end: p.end })
    })
  })

  it('uses the calendar hours for durations and lags', () => {
    const tenHour = { ...cal, hoursPerDay: 10 }
    const d = makeDraft([activity('A', 2.5), activity('T', 1)], [link('A', 'T', 'FS', 1)], 'T', '2026-12-04')
    const built = buildSheetFromDraft(d, planBackward(d, tenHour, TODAY), 'u', tenHour)
    const dur = built.columns.find((c) => c.role === 'duration')!.id
    expect(built.rows[0].cells[dur]).toBe('2d 5h')
    expect(built.dependencies[0].lagMinutes).toBe(600)
  })
})

/** The e2e fake Supabase with one signed-in user. */
function fakeClient() {
  const state = emptyState()
  const user = addUser(state, 'planner@example.com', 'planner-password')
  state.sessionUserId = user.id
  const map = new Map([[FAKE_STORAGE_KEY, JSON.stringify(state)]])
  const storage: StorageLike = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
  return { client: createFakeSupabase({ storage }) as unknown as SupabaseClient, userId: user.id }
}

describe('insertSheetFromDraft (fake Supabase)', () => {
  it('saves a sheet that loads back with the activities, predecessors and preview dates', async () => {
    const { client, userId } = fakeClient()
    const draft = lleDraft('2027-06-30')
    const sheetId = await insertSheetFromDraft(client, draft, userId, cal, { today: TODAY })
    const loaded = await supabasePersistence(client).loadSheet(sheetId)
    expect(loaded.sheet.name).toBe('LLE – 400 MVA transformer')
    expect(loaded.columns.map((c) => c.title).at(-1)).toBe('Basis')
    expect(loaded.rows).toHaveLength(8)
    expect(loaded.dependencies).toHaveLength(draft.links.length)

    const input = toSchedInput(loaded)!
    const result = schedule(input.rows, input.deps, input.calendar)
    const plan = planBackward(draft, cal, TODAY)
    const taskCol = loaded.columns[0].id
    for (const r of input.rows) {
      const name = loaded.rows.find((x) => x.id === r.id)!.cells[taskCol]
      const p = plan.activities.find((a) => a.name === name)!
      expect(result.byRow[r.id]).toMatchObject({ start: p.start, end: p.end })
    }
    // The predecessor text the grid shows for Shipping (row 7): Fabrication is row 6, a 2-day lead.
    const ship = input.rows.findIndex((r) => loaded.rows.find((x) => x.id === r.id)!.cells[taskCol] === 'Shipping')
    const preds = input.deps
      .filter((d) => d.successorId === input.rows[ship].id)
      .map((d) => ({ rowNumber: input.rows.findIndex((r) => r.id === d.predecessorId) + 1, type: d.type, lagMinutes: d.lagMinutes }))
    expect(formatPredecessors(preds)).toBe('6FS -2d')
  })

  it('throws before writing anything when the draft cannot be planned', async () => {
    const { client, userId } = fakeClient()
    const bad = makeDraft([activity('A', 1)], [], 'MISSING', '2026-12-04')
    await expect(insertSheetFromDraft(client, bad, userId, cal, { today: TODAY })).rejects.toThrow('MISSING')
    expect((await client.from('sheets').select('id')).data).toEqual([])
  })
})

/** Three items: two with identical activity codes (catalog drafts), one with overlapping ones (lleDraft). */
function threeDrafts() {
  const transformer = { ...catalogDraft('2027-09-30') }
  transformer.request = { ...transformer.request, equipmentType: 'Power transformer', equipmentName: '400 MVA transformer, Substation B' }
  const switchgear = catalogDraft('2027-06-30', { domestic: true })
  switchgear.request = { ...switchgear.request, equipmentType: 'Switchgear', equipmentName: '132 kV GIS' }
  const chiller = lleDraft('2027-12-15')
  chiller.request = { ...chiller.request, equipmentType: 'Chiller', equipmentName: 'CH-1, 2 MW' }
  return [transformer, switchgear, chiller]
}

describe('sheetNameForDrafts / itemRowName', () => {
  it('names a combined sheet by its item count, and a single one as before', () => {
    const [a, b, c] = threeDrafts()
    expect(sheetNameForDrafts([a, b, c])).toBe('LLE plan – 3 items')
    expect(sheetNameForDrafts([a, b])).toBe('LLE plan – 2 items')
    expect(sheetNameForDrafts([a])).toBe('LLE – 400 MVA transformer, Substation B')
    const other = { ...a, request: { ...a.request, scheduleType: 'commissioning' } }
    expect(sheetNameForDrafts([other, other])).toBe('Plan – 2 items')
  })

  it('a summary row is "type — name", without repeating a type the name already contains', () => {
    const [a] = threeDrafts()
    expect(itemRowName(a)).toBe('Power transformer — 400 MVA transformer, Substation B')
    expect(itemRowName({ ...a, request: { ...a.request, equipmentType: 'Chiller', equipmentName: 'Chiller CH-1' } })).toBe('Chiller CH-1')
    expect(itemRowName({ ...a, request: { ...a.request, equipmentName: ' ' } })).toBe('Power transformer')
  })
})

describe('buildSheetFromDrafts', () => {
  const drafts = threeDrafts()
  const plans = drafts.map((d) => planBackward(d, cal, TODAY))
  const items = drafts.map((draft, i) => ({ draft, plan: plans[i] }))
  const data = buildSheetFromDrafts(items, 'user-1', cal)
  const col = (title: string) => data.columns.find((c) => c.title === title)!.id
  const parents = data.rows.filter((r) => r.parentId === null)
  const childrenOf = (id: string) => data.rows.filter((r) => r.parentId === id)

  it('shares the Project schedule columns plus Basis, with dependencies on and a combined name', () => {
    expect(data.columns.map((c) => c.title).at(-1)).toBe('Basis')
    expect(data.sheet).toMatchObject({ name: 'LLE plan – 3 items', ownerId: 'user-1', dependenciesEnabled: true })
    expect(data.rows).toHaveLength(3 + drafts.reduce((n, d) => n + d.activities.length, 0))
  })

  it('has one summary row per item, in order, named after the equipment, with no dates or predecessors of its own', () => {
    expect(parents).toHaveLength(3)
    expect(parents.map((p) => p.cells[col('Task')])).toEqual([
      'Power transformer — 400 MVA transformer, Substation B',
      'Switchgear — 132 kV GIS',
      'Chiller — CH-1, 2 MW',
    ])
    const positions = parents.map((p) => p.position)
    expect([...positions].sort()).toEqual(positions)
    for (const p of parents) {
      expect(p.cells).not.toHaveProperty(col('Start'))
      expect(p.cells).not.toHaveProperty(col('Duration'))
      expect(typeof p.cells[col('Basis')]).toBe('string')
    }
    const depIds = new Set(data.dependencies.flatMap((d) => [d.predecessorId, d.successorId]))
    for (const p of parents) expect(depIds.has(p.id)).toBe(false)
  })

  it('puts each item\'s activities under its summary row, in draft order, with Basis per activity', () => {
    parents.forEach((p, i) => {
      const kids = childrenOf(p.id)
      const d = drafts[i]
      expect(kids.map((k) => k.cells[col('Task')])).toEqual(d.activities.map((a) => a.name))
      const positions = kids.map((k) => k.position)
      expect([...positions].sort()).toEqual(positions)
      expect(new Set(positions).size).toBe(positions.length)
      kids.forEach((k, j) => expect(k.cells[col('Basis')]).toBe(basisText(d.activities[j], d.history)))
      expect(kids.every((k) => k.cells[col('Status')] === 'Not started')).toBe(true)
    })
    expect(data.rows.every((r) => r.parentId === null || parents.some((p) => p.id === r.parentId))).toBe(true) // one level deep
  })

  it('keeps dependencies inside each item even though the activity codes repeat across items', () => {
    const itemOf = new Map(data.rows.filter((r) => r.parentId).map((r) => [r.id, r.parentId]))
    expect(data.dependencies).toHaveLength(plans.reduce((n, p) => n + p.links.length, 0))
    for (const d of data.dependencies) expect(itemOf.get(d.predecessorId)).toBe(itemOf.get(d.successorId))
    // Per item: exactly that item's links, by name.
    parents.forEach((p, i) => {
      const kids = childrenOf(p.id)
      const ids = new Set(kids.map((k) => k.id))
      const mine = data.dependencies.filter((d) => ids.has(d.successorId))
      expect(mine).toHaveLength(plans[i].links.length)
      const nameOf = (id: string) => kids.find((k) => k.id === id)!.cells[col('Task')]
      const codeName = new Map(drafts[i].activities.map((a) => [a.code, a.name]))
      expect(mine.map((d) => `${nameOf(d.predecessorId)}>${nameOf(d.successorId)}`).sort()).toEqual(
        plans[i].links.map((l) => `${codeName.get(l.from)}>${codeName.get(l.to)}`).sort(),
      )
    })
  })

  it('schedules to exactly the dates of each preview, and a summary row spans its item', () => {
    const input = toSchedInput(data)!
    expect(input.rows.map((r) => r.id)).toEqual(
      parents.flatMap((p) => [p.id, ...childrenOf(p.id).map((k) => k.id)]), // depth-first: parent, then its children
    )
    const result = schedule(input.rows, input.deps, input.calendar)
    expect(result.errors).toEqual([])
    parents.forEach((p, i) => {
      const kids = childrenOf(p.id)
      kids.forEach((k, j) => expect(result.byRow[k.id]).toMatchObject({ start: plans[i].activities[j].start, end: plans[i].activities[j].end }))
      expect(result.byRow[p.id]).toMatchObject({ start: plans[i].mustStartBy, end: plans[i].projectEnd })
    })
    // Items are independent: their dates differ because their required dates do.
    expect(new Set(plans.map((p) => p.targetFinish)).size).toBe(3)
  })

  it('one item is the flat sheet from before: no summary row', () => {
    const one = buildSheetFromDrafts([items[0]], 'u', cal)
    expect(one.sheet.name).toBe('LLE – 400 MVA transformer, Substation B')
    expect(one.rows).toHaveLength(drafts[0].activities.length)
    expect(one.rows.every((r) => r.parentId === null)).toBe(true)
  })

  it('refuses an empty list', () => {
    expect(() => buildSheetFromDrafts([], 'u', cal)).toThrow(/nothing to plan/)
  })
})

type Res = { error: { message: string } | null }

/** A scripted client: records calls; `fail` names the table whose insert errors. */
function scriptedClient(opts: { fail?: string; deleteThrows?: boolean } = {}) {
  const calls: string[] = []
  const from = vi.fn((table: string) => ({
    insert: vi.fn(async (): Promise<Res> => {
      calls.push(`insert:${table}`)
      return { error: opts.fail === table ? { message: `${table} boom` } : null }
    }),
    delete: vi.fn(() => ({
      eq: vi.fn(async (): Promise<Res> => {
        calls.push(`delete:${table}`)
        if (opts.deleteThrows) throw new Error('cleanup boom')
        return { error: null }
      }),
    })),
  }))
  return { client: { from } as unknown as SupabaseClient, calls }
}

describe('insertSheetFromDraft (failures)', () => {
  const draft = lleDraft()
  it('inserts sheet, columns, rows, dependencies in order', async () => {
    const { client, calls } = scriptedClient()
    await insertSheetFromDraft(client, draft, 'u', cal, { today: TODAY })
    expect(calls).toEqual(['insert:sheets', 'insert:columns', 'insert:rows', 'insert:dependencies'])
  })

  it('skips the dependency insert when there are no links', async () => {
    const { client, calls } = scriptedClient()
    await insertSheetFromDraft(client, makeDraft([activity('T', 3)], [], 'T', '2026-12-04'), 'u', cal, { today: TODAY })
    expect(calls).toEqual(['insert:sheets', 'insert:columns', 'insert:rows'])
  })

  it.each(['columns', 'rows', 'dependencies'])('deletes the sheet and rethrows when the %s insert fails', async (table) => {
    const { client, calls } = scriptedClient({ fail: table })
    await expect(insertSheetFromDraft(client, draft, 'u', cal, { today: TODAY })).rejects.toThrow(`${table} boom`)
    expect(calls.at(-1)).toBe('delete:sheets')
    expect(calls).toContain(`insert:${table}`)
  })

  it('a failing cleanup still reports the original error', async () => {
    const { client } = scriptedClient({ fail: 'rows', deleteThrows: true })
    await expect(insertSheetFromDraft(client, draft, 'u', cal, { today: TODAY })).rejects.toThrow('rows boom')
  })

  it('nothing else is written when the sheet insert fails', async () => {
    const { client, calls } = scriptedClient({ fail: 'sheets' })
    await expect(insertSheetFromDraft(client, draft, 'u', cal, { today: TODAY })).rejects.toThrow('sheets boom')
    expect(calls).toEqual(['insert:sheets'])
  })
})

describe('insertSheetFromDrafts (several items)', () => {
  it('saves ONE sheet that loads back with parent rows, children and the preview dates', async () => {
    const { client, userId } = fakeClient()
    const drafts = threeDrafts()
    const sheetId = await insertSheetFromDrafts(client, drafts, userId, cal, { today: TODAY })
    expect((await client.from('sheets').select('id,name')).data).toEqual([{ id: sheetId, name: 'LLE plan – 3 items' }])

    const loaded = await supabasePersistence(client).loadSheet(sheetId)
    expect(loaded.rows).toHaveLength(3 + drafts.reduce((n, d) => n + d.activities.length, 0))
    expect(loaded.rows.filter((r) => r.parentId === null)).toHaveLength(3)
    expect(loaded.dependencies).toHaveLength(drafts.reduce((n, d) => n + planBackward(d, cal, TODAY).links.length, 0))

    const input = toSchedInput(loaded)!
    const result = schedule(input.rows, input.deps, input.calendar)
    expect(result.errors).toEqual([])
    const taskCol = loaded.columns[0].id
    const top = loaded.rows.filter((r) => r.parentId === null).sort((a, b) => (a.position < b.position ? -1 : 1))
    top.forEach((p, i) => {
      const plan = planBackward(drafts[i], cal, TODAY)
      expect(result.byRow[p.id]).toMatchObject({ start: plan.mustStartBy, end: plan.projectEnd })
      for (const k of loaded.rows.filter((r) => r.parentId === p.id)) {
        const planned = plan.activities.find((a) => a.name === k.cells[taskCol])!
        expect(result.byRow[k.id]).toMatchObject({ start: planned.start, end: planned.end })
      }
    })
  })

  it('one draft saves the same flat sheet insertSheetFromDraft does', async () => {
    const { client, userId } = fakeClient()
    const sheetId = await insertSheetFromDrafts(client, [lleDraft('2027-06-30')], userId, cal, { today: TODAY })
    const loaded = await supabasePersistence(client).loadSheet(sheetId)
    expect(loaded.sheet.name).toBe('LLE – 400 MVA transformer')
    expect(loaded.rows).toHaveLength(8)
    expect(loaded.rows.every((r) => r.parentId === null)).toBe(true)
  })

  it('throws before writing anything when one of the drafts cannot be planned', async () => {
    const { client, userId } = fakeClient()
    const bad = makeDraft([activity('A', 1)], [], 'MISSING', '2026-12-04')
    await expect(insertSheetFromDrafts(client, [lleDraft(), bad], userId, cal, { today: TODAY })).rejects.toThrow('MISSING')
    expect((await client.from('sheets').select('id')).data).toEqual([])
  })

  it('inserts sheet, columns, rows, dependencies once, in order; parents come before their children', async () => {
    const { client, calls } = scriptedClient()
    await insertSheetFromDrafts(client, threeDrafts(), 'u', cal, { today: TODAY })
    expect(calls).toEqual(['insert:sheets', 'insert:columns', 'insert:rows', 'insert:dependencies'])
  })

  it.each(['columns', 'rows', 'dependencies'])('deletes the whole sheet and rethrows when the %s insert fails', async (table) => {
    const { client, calls } = scriptedClient({ fail: table })
    await expect(insertSheetFromDrafts(client, threeDrafts(), 'u', cal, { today: TODAY })).rejects.toThrow(`${table} boom`)
    expect(calls.at(-1)).toBe('delete:sheets')
    expect(calls.filter((c) => c === 'insert:sheets')).toHaveLength(1)
  })

  it('a failing cleanup still reports the original error', async () => {
    const { client } = scriptedClient({ fail: 'rows', deleteThrows: true })
    await expect(insertSheetFromDrafts(client, threeDrafts(), 'u', cal, { today: TODAY })).rejects.toThrow('rows boom')
  })
})

describe('Cost code column', () => {
  const CC: CostCodeColumn = { options: ['CHL — Chiller', 'GEN — Generator'], values: ['GEN — Generator', undefined, 'CHL — Chiller'] }
  const plannedOf = (drafts: ReturnType<typeof threeDrafts>) => drafts.map((draft) => ({ draft, plan: planBackward(draft, cal, TODAY) }))
  const twoOrMore = plannedOf(threeDrafts())
  const oneItem = plannedOf([lleDraft('2027-06-30')])
  const costCol = (columns: { id: string; title: string }[]) => columns.find((c) => c.title === 'Cost code')?.id

  it('adds a strict Cost code dropdown just before Basis', () => {
    const { columns } = buildSheetFromDrafts(twoOrMore, 'u', cal, CC)
    const i = columns.findIndex((c) => c.title === 'Cost code')
    expect(columns[i]).toMatchObject({ type: 'PICKLIST', options: ['CHL — Chiller', 'GEN — Generator'] })
    expect(columns[i + 1].title).toBe('Basis')
  })

  it('puts each item’s code on its summary row only', () => {
    const { columns, rows } = buildSheetFromDrafts(twoOrMore, 'u', cal, CC)
    const col = costCol(columns)!
    const parents = rows.filter((r) => r.parentId === null)
    expect(parents.map((r) => r.cells[col])).toEqual(['GEN — Generator', undefined, 'CHL — Chiller'])
    expect(rows.filter((r) => r.parentId !== null).every((r) => r.cells[col] === undefined)).toBe(true)
  })

  it('puts a single item’s code on every row', () => {
    const { columns, rows } = buildSheetFromDrafts(oneItem, 'u', cal, { options: CC.options, values: ['CHL — Chiller'] })
    const col = costCol(columns)!
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.every((r) => r.cells[col] === 'CHL — Chiller')).toBe(true)
  })

  it('ignores a value that is not one of the options', () => {
    const { columns, rows } = buildSheetFromDrafts(oneItem, 'u', cal, { options: CC.options, values: ['UPS — UPS & Battery System'] })
    const col = costCol(columns)!
    expect(rows.every((r) => r.cells[col] === undefined)).toBe(true)
  })

  it('adds no column without cost codes or with no options', () => {
    expect(costCol(buildSheetFromDrafts(twoOrMore, 'u', cal).columns)).toBeUndefined()
    expect(costCol(buildSheetFromDrafts(twoOrMore, 'u', cal, { options: [], values: [] }).columns)).toBeUndefined()
    expect(costCol(buildSheetFromDraft(oneItem[0].draft, oneItem[0].plan, 'u', cal).columns)).toBeUndefined()
  })

  it('saves the column and the codes, and they load back', async () => {
    const { client, userId } = fakeClient()
    const sheetId = await insertSheetFromDrafts(client, threeDrafts(), userId, cal, { today: TODAY, costCodes: CC })
    const loaded = await supabasePersistence(client).loadSheet(sheetId)
    const column = loaded.columns.find((c) => c.title === 'Cost code')!
    expect(column).toMatchObject({ type: 'PICKLIST', options: CC.options })
    const parents = loaded.rows.filter((r) => r.parentId === null).sort((a, b) => (a.position < b.position ? -1 : 1))
    expect(parents.map((r) => r.cells[column.id])).toEqual(['GEN — Generator', undefined, 'CHL — Chiller'])
  })
})

describe('Procore project column', () => {
  const CC: CostCodeColumn = { options: ['CHL — Chiller', 'GEN — Generator'], values: ['GEN — Generator', undefined, 'CHL — Chiller'] }
  const P: ProjectColumn = { options: ['BKK-03 — Bangkok 3'], value: 'BKK-03 — Bangkok 3' }
  const plannedOf = (drafts: ReturnType<typeof threeDrafts>) => drafts.map((draft) => ({ draft, plan: planBackward(draft, cal, TODAY) }))
  const three = plannedOf(threeDrafts())
  const one = plannedOf([lleDraft('2027-06-30')])
  const titles = (columns: { title: string }[]) => columns.map((c) => c.title)
  const projectCol = (columns: { id: string; title: string }[]) => columns.find((c) => c.title === 'Project')?.id

  it('adds a strict Procore project dropdown just before Cost code', () => {
    const { columns } = buildSheetFromDrafts(three, 'u', cal, CC, P)
    expect(titles(columns).slice(-3)).toEqual(['Project', 'Cost code', 'Basis'])
    expect(columns.find((c) => c.title === 'Project')).toMatchObject({ type: 'PICKLIST', options: P.options })
  })

  it('goes just before Basis when there is no Cost code column', () => {
    const { columns } = buildSheetFromDrafts(three, 'u', cal, undefined, P)
    expect(titles(columns).slice(-2)).toEqual(['Project', 'Basis'])
  })

  it('puts the project on every summary row only', () => {
    const { columns, rows } = buildSheetFromDrafts(three, 'u', cal, CC, P)
    const col = projectCol(columns)!
    expect(rows.filter((r) => r.parentId === null).map((r) => r.cells[col])).toEqual(Array(3).fill('BKK-03 — Bangkok 3'))
    expect(rows.filter((r) => r.parentId !== null).every((r) => r.cells[col] === undefined)).toBe(true)
  })

  it('puts a single item’s project on every row', () => {
    const { columns, rows } = buildSheetFromDrafts(one, 'u', cal, undefined, P)
    const col = projectCol(columns)!
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.every((r) => r.cells[col] === 'BKK-03 — Bangkok 3')).toBe(true)
  })

  it('adds the column with empty cells when no project was chosen', () => {
    const { columns, rows } = buildSheetFromDrafts(three, 'u', cal, CC, { options: P.options })
    const col = projectCol(columns)!
    expect(rows.every((r) => r.cells[col] === undefined)).toBe(true)
  })

  it('ignores a value that is not one of the options', () => {
    const { columns, rows } = buildSheetFromDrafts(one, 'u', cal, undefined, { options: P.options, value: 'XYZ — Nowhere' })
    const col = projectCol(columns)!
    expect(rows.every((r) => r.cells[col] === undefined)).toBe(true)
  })

  it('adds no column without projects', () => {
    expect(projectCol(buildSheetFromDrafts(three, 'u', cal, CC).columns)).toBeUndefined()
    expect(projectCol(buildSheetFromDrafts(three, 'u', cal, CC, { options: [] }).columns)).toBeUndefined()
  })

  it('saves the column and the project, and they load back', async () => {
    const { client, userId } = fakeClient()
    const sheetId = await insertSheetFromDrafts(client, threeDrafts(), userId, cal, { today: TODAY, costCodes: CC, project: P })
    const loaded = await supabasePersistence(client).loadSheet(sheetId)
    const column = loaded.columns.find((c) => c.title === 'Project')!
    expect(column).toMatchObject({ type: 'PICKLIST', options: P.options })
    expect(loaded.rows.filter((r) => r.parentId === null).map((r) => r.cells[column.id])).toEqual(Array(3).fill('BKK-03 — Bangkok 3'))
  })
})

describe('Delivery site column', () => {
  const CC: CostCodeColumn = { options: ['CHL — Chiller', 'GEN — Generator'], values: ['GEN — Generator', undefined, 'CHL — Chiller'] }
  const P: ProjectColumn = { options: ['PRG-DC-01 — Data centre programme', 'BKK-03 — Bangkok 3'], value: 'PRG-DC-01 — Data centre programme' }
  const S: DeliverySiteColumn = { options: ['BKK-03 — Bangkok 3', 'SIN-01 — Singapore 1'], values: ['BKK-03 — Bangkok 3', undefined, 'SIN-01 — Singapore 1'] }
  const plannedOf = (drafts: ReturnType<typeof threeDrafts>) => drafts.map((draft) => ({ draft, plan: planBackward(draft, cal, TODAY) }))
  const three = plannedOf(threeDrafts())
  const one = plannedOf([lleDraft('2027-06-30')])
  const titles = (columns: { title: string }[]) => columns.map((c) => c.title)
  const colId = (columns: { id: string; title: string }[], title: string) => columns.find((c) => c.title === title)?.id

  it('adds a strict Delivery site dropdown after Cost code', () => {
    const { columns } = buildSheetFromDrafts(three, 'u', cal, CC, P, S)
    expect(titles(columns).slice(-4)).toEqual(['Project', 'Cost code', 'Delivery site', 'Basis'])
    expect(columns.find((c) => c.title === 'Delivery site')).toMatchObject({ type: 'PICKLIST', options: S.options })
  })

  it('goes just before Basis on its own', () => {
    const { columns } = buildSheetFromDrafts(three, 'u', cal, undefined, undefined, S)
    expect(titles(columns).slice(-2)).toEqual(['Delivery site', 'Basis'])
  })

  it('puts each item’s site on its summary row and on every one of its activities', () => {
    const { columns, rows } = buildSheetFromDrafts(three, 'u', cal, CC, P, S)
    const col = colId(columns, 'Delivery site')!
    const parents = rows.filter((r) => r.parentId === null)
    parents.forEach((parent, i) => {
      expect(parent.cells[col]).toBe(S.values[i])
      const children = rows.filter((r) => r.parentId === parent.id)
      expect(children.length).toBeGreaterThan(0)
      for (const child of children) expect(child.cells[col]).toBe(S.values[i])
    })
  })

  it('puts a single item’s site on every row', () => {
    const { columns, rows } = buildSheetFromDrafts(one, 'u', cal, undefined, undefined, { options: S.options, values: ['SIN-01 — Singapore 1'] })
    const col = colId(columns, 'Delivery site')!
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.every((r) => r.cells[col] === 'SIN-01 — Singapore 1')).toBe(true)
  })

  it('ignores a value that is not one of the options', () => {
    const { columns, rows } = buildSheetFromDrafts(one, 'u', cal, undefined, undefined, { options: S.options, values: ['XYZ — Nowhere'] })
    const col = colId(columns, 'Delivery site')!
    expect(rows.every((r) => r.cells[col] === undefined)).toBe(true)
  })

  it('adds no column without sites', () => {
    expect(colId(buildSheetFromDrafts(three, 'u', cal, CC, P).columns, 'Delivery site')).toBeUndefined()
    expect(colId(buildSheetFromDrafts(three, 'u', cal, CC, P, { options: [], values: [] }).columns, 'Delivery site')).toBeUndefined()
  })

  it('keeps the cost code and project on summary rows only', () => {
    const { columns, rows } = buildSheetFromDrafts(three, 'u', cal, CC, P, S)
    const code = colId(columns, 'Cost code')!
    const project = colId(columns, 'Project')!
    for (const child of rows.filter((r) => r.parentId !== null)) {
      expect(child.cells[code]).toBeUndefined()
      expect(child.cells[project]).toBeUndefined()
    }
  })

  it('saves the column and the sites, and they load back', async () => {
    const { client, userId } = fakeClient()
    const sheetId = await insertSheetFromDrafts(client, threeDrafts(), userId, cal, { today: TODAY, deliverySites: S })
    const loaded = await supabasePersistence(client).loadSheet(sheetId)
    const column = loaded.columns.find((c) => c.title === 'Delivery site')!
    expect(column).toMatchObject({ type: 'PICKLIST', options: S.options })
    const withSite = loaded.rows.filter((r) => r.cells[column.id] === 'BKK-03 — Bangkok 3')
    expect(withSite.length).toBeGreaterThan(1)
  })
})

describe('project column title', () => {
  it('calls the project column Project', () => {
    expect(PROJECT_COLUMN_TITLE).toBe('Project')
  })
})

describe('imported activities on the sheet', () => {
  it('writes each activity’s own status', () => {
    const draft = lleDraft('2027-06-30')
    draft.activities[0] = { ...draft.activities[0], status: 'In progress' }
    const plan = planBackward(draft, cal, TODAY)
    const { columns, rows } = buildSheetFromDraft(draft, plan, 'u', cal)
    const status = columns.find((c) => c.role === 'status')!.id
    expect(rows[0].cells[status]).toBe('In progress')
    expect(rows[1].cells[status]).toBe('Not started')
  })
})
