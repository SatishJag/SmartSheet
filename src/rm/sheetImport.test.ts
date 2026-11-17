import { describe, expect, it } from 'vitest'
import { extractSheetWork, projectFromSheet } from './sheetImport'
import { blankPerson, type Person } from './types'

const june: Person = { ...blankPerson(), id: 'june', first_name: 'June', email: 'june@example.com' }
const columns = [
  { id: 's', type: 'DATE', role: 'start' },
  { id: 'e', type: 'DATE', role: 'end' },
  { id: 'who', type: 'CONTACT_LIST', role: null },
]

describe('extractSheetWork', () => {
  it('finds the date span and assigns matching contacts over their rows', () => {
    const work = extractSheetWork(
      columns,
      [
        { cells: { s: '2026-11-20', e: '2026-11-27', who: 'June@Example.com' } },
        { cells: { s: '2026-11-16', e: '2026-11-18', who: 'nobody@example.com' } },
        { cells: { s: '2026-12-01' } },
        { cells: { who: 'june@example.com' } },
      ],
      [june],
    )
    expect(work.starts_at).toBe('2026-11-16')
    expect(work.ends_at).toBe('2026-12-01')
    expect(work.assignments).toEqual([
      { person_id: 'june', starts_at: '2026-11-20', ends_at: '2026-11-27', allocation_percent: 100, status: 'confirmed', notes: null },
    ])
    expect(work.unmatched).toEqual(['nobody@example.com'])
  })

  it('handles sheets without date columns', () => {
    const work = extractSheetWork([{ id: 'x', type: 'TEXT_NUMBER', role: null }], [{ cells: { x: 'a' } }], [june])
    expect(work).toEqual({ starts_at: null, ends_at: null, assignments: [], unmatched: [] })
    const p = projectFromSheet('Tower', 'sheet-1', work, '2026-11-16')
    expect(p).toMatchObject({ name: 'Tower', sheet_id: 'sheet-1', starts_at: '2026-11-16', ends_at: '2026-11-16' })
  })
})
