// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createSupabaseHistorySource } from './history'

type Result = { data: unknown; error: { message: string } | null }
type Call = { target: string; method: string; args: unknown[] }

/**
 * A minimal stand-in for the Supabase client: `from(table)` returns a chainable query builder that
 * records its calls and resolves to the canned result for that table; `rpc` resolves to the canned
 * result for that function. Enough to check the mapping and the queries history.ts makes.
 */
function fakeClient(results: Record<string, Result>) {
  const calls: Call[] = []
  const resultFor = (target: string): Result => results[target] ?? { data: null, error: { message: `no fake result for ${target}` } }
  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'order', 'in', 'limit']) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ target: table, method, args })
          return builder
        }
      }
      builder.then = (ok: (r: Result) => unknown, fail: (e: unknown) => unknown) => Promise.resolve(resultFor(table)).then(ok, fail)
      return builder
    },
    rpc(fn: string, args: unknown) {
      calls.push({ target: fn, method: 'rpc', args: [args] })
      return Promise.resolve(resultFor(fn))
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

const ok = (data: unknown): Result => ({ data, error: null })

describe('createSupabaseHistorySource', () => {
  describe('options', () => {
    it('lists schedule types and, per type, the equipment types that have history', async () => {
      const { client, calls } = fakeClient({
        schedule_types: ok([
          { id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'From spec to site' },
          { id: 'civil', name: 'Civil works', description: null },
        ]),
        planner_equipment_types: ok([
          { schedule_type: 'lle-procurement', equipment_type: 'Chiller' },
          { schedule_type: 'lle-procurement', equipment_type: 'Power transformer' },
          { schedule_type: 'orphan', equipment_type: 'Crane' },
        ]),
      })
      const options = await createSupabaseHistorySource(client).options()
      expect(options).toEqual({
        scheduleTypes: [
          { id: 'lle-procurement', name: 'Long-lead equipment procurement', description: 'From spec to site' },
          { id: 'civil', name: 'Civil works', description: '' },
        ],
        // Every schedule type gets an entry, even without history; unknown types are ignored.
        equipmentTypes: { 'lle-procurement': ['Chiller', 'Power transformer'], civil: [] },
      })
      expect(calls.filter((c) => c.method === 'select').map((c) => c.target).sort()).toEqual(['planner_equipment_types', 'schedule_types'])
    })

    it('throws with the Supabase message when a query fails', async () => {
      const { client } = fakeClient({
        schedule_types: ok([]),
        planner_equipment_types: { data: null, error: { message: 'permission denied for view planner_equipment_types' } },
      })
      await expect(createSupabaseHistorySource(client).options()).rejects.toThrow('permission denied for view planner_equipment_types')
    })
  })

  describe('catalog', () => {
    const row = {
      schedule_type: 'lle-procurement',
      code: 'MFG',
      name: 'Manufacturing',
      phase: 'Manufacturing',
      sequence: 8,
      default_links: [
        { from: 'DWGAPP', type: 'FS', lagDays: 0 },
        { from: 'RAWMAT', type: 'SS', lagDays: 15 },
      ],
      default_days: 60,
      is_target: false,
    }

    it('maps snake_case rows to catalog activities, filtered by type and ordered by sequence', async () => {
      const { client, calls } = fakeClient({
        activity_catalog: ok([row, { ...row, code: 'ONSITE', name: 'On site', phase: 'Milestone', sequence: 14, default_links: [{ from: 'DELIVER', type: 'FS' }], default_days: 0, is_target: true }]),
      })
      const catalog = await createSupabaseHistorySource(client).catalog('lle-procurement')
      expect(catalog).toEqual([
        {
          scheduleType: 'lle-procurement',
          code: 'MFG',
          name: 'Manufacturing',
          phase: 'Manufacturing',
          sequence: 8,
          defaultLinks: [
            { from: 'DWGAPP', type: 'FS', lagDays: 0 },
            { from: 'RAWMAT', type: 'SS', lagDays: 15 },
          ],
          defaultDays: 60,
          isTarget: false,
        },
        {
          scheduleType: 'lle-procurement',
          code: 'ONSITE',
          name: 'On site',
          phase: 'Milestone',
          sequence: 14,
          // A missing lag is 0.
          defaultLinks: [{ from: 'DELIVER', type: 'FS', lagDays: 0 }],
          defaultDays: 0,
          isTarget: true,
        },
      ])
      expect(calls).toContainEqual({ target: 'activity_catalog', method: 'eq', args: ['schedule_type', 'lle-procurement'] })
      expect(calls).toContainEqual({ target: 'activity_catalog', method: 'order', args: ['sequence', { ascending: true }] })
    })

    it('rejects a malformed default link instead of guessing', async () => {
      const { client } = fakeClient({ activity_catalog: ok([{ ...row, default_links: [{ from: 'DWGAPP', type: 'XX', lagDays: 0 }] }]) })
      await expect(createSupabaseHistorySource(client).catalog('lle-procurement')).rejects.toThrow(/MFG/)
    })

    it('returns an empty list for a type with no catalog, and throws Supabase errors', async () => {
      expect(await createSupabaseHistorySource(fakeClient({ activity_catalog: ok([]) }).client).catalog('x')).toEqual([])
      const { client } = fakeClient({ activity_catalog: { data: null, error: { message: 'JWT expired' } } })
      await expect(createSupabaseHistorySource(client).catalog('x')).rejects.toThrow('JWT expired')
    })
  })

  describe('summary', () => {
    const summary = {
      scheduleType: 'lle-procurement',
      equipmentType: 'Chiller',
      projectCount: 9,
      sampleOnly: true,
      stats: [{ code: 'MFG', n: 9, p50: 50, p80: 57, min: 35, max: 59 }],
    }

    it('calls planner_history_summary and returns its statistics', async () => {
      const { client, calls } = fakeClient({ planner_history_summary: ok(summary) })
      expect(await createSupabaseHistorySource(client).summary('lle-procurement', 'Chiller')).toEqual(summary)
      expect(calls).toEqual([
        { target: 'planner_history_summary', method: 'rpc', args: [{ p_schedule_type: 'lle-procurement', p_equipment_type: 'Chiller' }] },
      ])
    })

    it('passes null to summarize every equipment type', async () => {
      const all = { ...summary, equipmentType: null, projectCount: 38 }
      const { client, calls } = fakeClient({ planner_history_summary: ok(all) })
      expect(await createSupabaseHistorySource(client).summary('lle-procurement', null)).toEqual(all)
      expect(calls[0].args[0]).toEqual({ p_schedule_type: 'lle-procurement', p_equipment_type: null })
    })

    it('normalizes numbers and missing fields, keeping only contract keys', async () => {
      const { client } = fakeClient({
        planner_history_summary: ok({
          scheduleType: 'lle-procurement',
          equipmentType: 'Chiller',
          projectCount: '2',
          sampleOnly: false,
          stats: [{ code: 'FAT', n: '2', p50: 3, p80: 4, min: 2, max: 5, extra: 'x' }],
        }),
      })
      expect(await createSupabaseHistorySource(client).summary('lle-procurement', 'Chiller')).toEqual({
        scheduleType: 'lle-procurement',
        equipmentType: 'Chiller',
        projectCount: 2,
        sampleOnly: false,
        stats: [{ code: 'FAT', n: 2, p50: 3, p80: 4, min: 2, max: 5 }],
      })
      const empty = fakeClient({ planner_history_summary: ok({ scheduleType: 'x', equipmentType: null, projectCount: 0, sampleOnly: false, stats: null }) })
      expect((await createSupabaseHistorySource(empty.client).summary('x', null)).stats).toEqual([])
    })

    it('throws with the Supabase message, or when the function returns nothing', async () => {
      const failed = fakeClient({ planner_history_summary: { data: null, error: { message: 'permission denied for function planner_history_summary' } } })
      await expect(createSupabaseHistorySource(failed.client).summary('x', null)).rejects.toThrow(
        'permission denied for function planner_history_summary',
      )
      const nothing = fakeClient({ planner_history_summary: ok(null) })
      await expect(createSupabaseHistorySource(nothing.client).summary('x', null)).rejects.toThrow(/no summary/i)
    })
  })
})
