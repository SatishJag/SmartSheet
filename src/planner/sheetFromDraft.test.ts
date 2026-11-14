import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { addUser, createFakeSupabase, emptyState, FAKE_STORAGE_KEY, type StorageLike } from '../../e2e/support/fakeSupabase'
import { defaultCalendar } from '../engine/calendar'
import { formatPredecessors } from '../engine/predecessor'
import { schedule } from '../engine/schedule'
import { supabasePersistence } from '../store/persistence'
import { toSchedInput } from '../store/scheduleInput'
import { activity, link, lleDraft, makeDraft, sampleHistory } from '../test/plannerFixtures'
import { planBackward } from './backward'
import { basisText, buildSheetFromDraft, insertSheetFromDraft, sheetNameForDraft } from './sheetFromDraft'

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
