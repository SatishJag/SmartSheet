import { describe, expect, it } from 'vitest'
import { inferColumnType, MAX_IMPORT_COLUMNS, MAX_IMPORT_ROWS, sheetFromCsv, sheetNameFromFile } from './sheetFromCsv'

describe('inferColumnType', () => {
  it('maps all-date, all-boolean and everything else', () => {
    expect(inferColumnType(['2026-01-31', '', '2026-02-01'])).toBe('DATE')
    expect(inferColumnType(['true', 'FALSE', ''])).toBe('CHECKBOX')
    expect(inferColumnType(['1', '2.5'])).toBe('TEXT_NUMBER')
    expect(inferColumnType(['hello', '3'])).toBe('TEXT_NUMBER')
    expect(inferColumnType(['', ''])).toBe('TEXT_NUMBER')
  })

  it('falls back to text when any value fails validation', () => {
    expect(inferColumnType(['2026-01-31', '2026-02-30'])).toBe('TEXT_NUMBER') // not a real date
    expect(inferColumnType(['2026-01-31', '31/01/2026'])).toBe('TEXT_NUMBER')
    expect(inferColumnType(['2026-01-31', '1969-12-31'])).toBe('TEXT_NUMBER') // outside accepted range
    expect(inferColumnType(['true', 'yes'])).toBe('TEXT_NUMBER')
  })
})

describe('sheetFromCsv', () => {
  const csv = 'Task,Due,Done,Cost\nPour slab,2026-03-01,true,1200\nFraming,2026-03-09,false,007\n'

  it('builds typed columns, cells and ordered fractional positions with fresh ids', () => {
    const d = sheetFromCsv(csv, 'Plan', 'u1')
    expect(d.sheet).toMatchObject({ name: 'Plan', ownerId: 'u1', workspaceId: 'u1', dependenciesEnabled: false })
    expect(d.columns.map((c) => [c.title, c.type])).toEqual([
      ['Task', 'TEXT_NUMBER'],
      ['Due', 'DATE'],
      ['Done', 'CHECKBOX'],
      ['Cost', 'TEXT_NUMBER'],
    ])
    const [task, due, done, cost] = d.columns.map((c) => c.id)
    expect(d.rows[0].cells).toEqual({ [task]: 'Pour slab', [due]: '2026-03-01', [done]: true, [cost]: 1200 })
    expect(d.rows[1].cells[done]).toBe(false)
    expect(d.rows[1].cells[cost]).toBe('007') // not coerced: nothing is lost
    expect(d.rows[0].position < d.rows[1].position).toBe(true)
    expect(new Set([d.sheet.id, ...d.columns.map((c) => c.id), ...d.rows.map((r) => r.id)]).size).toBe(7)
    expect(d.dependencies).toEqual([])
  })

  it('names blank and duplicate headers', () => {
    const d = sheetFromCsv('A,,a,A\n1,2,3,4', 'x', 'u')
    expect(d.columns.map((c) => c.title)).toEqual(['A', 'Column 2', 'a (2)', 'A (3)'])
  })

  it('widens for ragged rows so no value is dropped, and leaves missing cells empty', () => {
    const d = sheetFromCsv('A\n1,2\n3', 'x', 'u')
    expect(d.columns.map((c) => c.title)).toEqual(['A', 'Column 2'])
    expect(d.rows[0].cells[d.columns[1].id]).toBe(2)
    expect(d.rows[1].cells).toEqual({ [d.columns[0].id]: 3 })
  })

  it('gives header-only and empty files columns and zero rows', () => {
    expect(sheetFromCsv('A,B\n', 'x', 'u')).toMatchObject({ rows: [], columns: [{ title: 'A' }, { title: 'B' }] })
    expect(sheetFromCsv('', 'x', 'u')).toMatchObject({ rows: [], columns: [{ title: 'Column 1', type: 'TEXT_NUMBER' }] })
  })

  it('refuses files over the row or column limit instead of truncating', () => {
    const rows = 'A\n' + '1\n'.repeat(MAX_IMPORT_ROWS + 1)
    expect(() => sheetFromCsv(rows, 'x', 'u')).toThrow(/import limit is 5000/)
    expect(sheetFromCsv('A\n' + '1\n'.repeat(MAX_IMPORT_ROWS), 'x', 'u').rows).toHaveLength(MAX_IMPORT_ROWS)
    const wide = Array.from({ length: MAX_IMPORT_COLUMNS + 1 }, (_, i) => `h${i}`).join(',')
    expect(() => sheetFromCsv(wide, 'x', 'u')).toThrow(/import limit is 50/)
  })
})

describe('sheetNameFromFile', () => {
  it('drops the extension, caps the length and falls back when empty', () => {
    expect(sheetNameFromFile('Punch list.CSV')).toBe('Punch list')
    expect(sheetNameFromFile('x'.repeat(200) + '.csv')).toHaveLength(100)
    expect(sheetNameFromFile('.csv')).toBe('Imported sheet')
  })
})
