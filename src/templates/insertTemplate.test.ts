import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { insertSheetFromTemplate } from './insertTemplate'

type Res = { error: { message: string } | null }

function makeClient(opts: { sheetErr?: string; colErr?: string; deleteThrows?: boolean } = {}) {
  const calls: string[] = []
  const inserts: { table: string; payload: any }[] = []
  const deletes: { table: string; col: string; val: unknown }[] = []
  const from = vi.fn((table: string) => ({
    insert: vi.fn(async (payload: unknown): Promise<Res> => {
      calls.push(`insert:${table}`)
      inserts.push({ table, payload })
      const msg = table === 'sheets' ? opts.sheetErr : opts.colErr
      return { error: msg ? { message: msg } : null }
    }),
    delete: vi.fn(() => ({
      eq: vi.fn(async (col: string, val: unknown): Promise<Res> => {
        calls.push(`delete:${table}`)
        deletes.push({ table, col, val })
        if (opts.deleteThrows) throw new Error('cleanup boom')
        return { error: null }
      }),
    })),
  }))
  return { client: { from } as unknown as SupabaseClient, calls, inserts, deletes }
}

describe('insertSheetFromTemplate', () => {
  it.each([
    ['project-schedule', 9],
    ['punch-list', 6],
  ] as const)('inserts the sheet then one bulk column insert for %s', async (id, n) => {
    const { client, calls, inserts } = makeClient()
    const sheetId = await insertSheetFromTemplate(client, id, 'user-1')
    expect(calls).toEqual(['insert:sheets', 'insert:columns'])
    const sheet = inserts[0].payload
    expect(sheet).toMatchObject({
      id: sheetId,
      owner_id: 'user-1',
      workspace_id: 'user-1',
      dependencies_enabled: id === 'project-schedule',
    })
    expect(sheet.calendar).toEqual({ workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 })
    expect(typeof sheet.name).toBe('string')
    const cols = inserts[1].payload as any[]
    expect(Array.isArray(cols)).toBe(true)
    expect(cols).toHaveLength(n)
    expect(cols.map((c) => c.position)).toEqual(cols.map((_, i) => i))
    for (const c of cols) expect(c).toMatchObject({ sheet_id: sheetId, owner_id: 'user-1', workspace_id: 'user-1' })
  })

  it('deletes the sheet and rethrows when the column insert fails', async () => {
    const { client, calls, deletes, inserts } = makeClient({ colErr: 'cols boom' })
    await expect(insertSheetFromTemplate(client, 'punch-list', 'u')).rejects.toThrow('cols boom')
    expect(calls).toEqual(['insert:sheets', 'insert:columns', 'delete:sheets'])
    expect(deletes[0]).toEqual({ table: 'sheets', col: 'id', val: inserts[0].payload.id })
  })

  it('swallows a failing cleanup and still throws the original error', async () => {
    const { client } = makeClient({ colErr: 'cols boom', deleteThrows: true })
    await expect(insertSheetFromTemplate(client, 'punch-list', 'u')).rejects.toThrow('cols boom')
  })

  it('does not insert columns when the sheet insert fails', async () => {
    const { client, calls } = makeClient({ sheetErr: 'sheet boom' })
    await expect(insertSheetFromTemplate(client, 'punch-list', 'u')).rejects.toThrow('sheet boom')
    expect(calls).toEqual(['insert:sheets'])
  })
})
