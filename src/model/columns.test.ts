import { describe, expect, it } from 'vitest'
import { makeSheetData } from '../test/fixtures'
import { columnLock, normalizeOptions, renameFormulaReferences, validateColumnTitle } from './columns'
import type { Column } from './validate'

const cols: Column[] = [
  { id: 'a', title: 'Task', type: 'TEXT_NUMBER' },
  { id: 'b', title: 'Trade', type: 'TEXT_NUMBER' },
]

describe('validateColumnTitle', () => {
  it('trims and accepts a new unique title', () => {
    expect(validateColumnTitle('  Cost ', cols)).toEqual({ ok: true, title: 'Cost' })
  })

  it('rejects an empty title', () => {
    expect(validateColumnTitle('   ', cols)).toEqual({ ok: false, error: 'Enter a column name' })
  })

  it('rejects a duplicate title, ignoring case', () => {
    expect(validateColumnTitle('trade', cols)).toEqual({ ok: false, error: 'A column named "Trade" already exists' })
  })

  it('allows a column to keep its own title (or change its case) when renaming', () => {
    expect(validateColumnTitle('TRADE', cols, 'b')).toEqual({ ok: true, title: 'TRADE' })
  })

  it('rejects square brackets, which formulas use for column references', () => {
    expect(validateColumnTitle('Cost [USD]', cols).ok).toBe(false)
  })

  it('rejects titles over 100 characters', () => {
    expect(validateColumnTitle('x'.repeat(101), cols).ok).toBe(false)
    expect(validateColumnTitle('x'.repeat(100), cols).ok).toBe(true)
  })
})

describe('normalizeOptions', () => {
  it('trims, drops blanks and duplicates, keeping order', () => {
    expect(normalizeOptions([' Open ', '', 'Done', 'Open'])).toEqual({ ok: true, options: ['Open', 'Done'] })
  })

  it('requires at least one option', () => {
    expect(normalizeOptions(['  '])).toEqual({ ok: false, error: 'Add at least one option' })
  })

  it('rejects commas (multi-picklist values are comma separated)', () => {
    expect(normalizeOptions(['A, B']).ok).toBe(false)
  })
})

describe('renameFormulaReferences', () => {
  it('rewrites [Old] references, tolerating inner spaces', () => {
    expect(renameFormulaReferences('=[Cost] * 2 + [ Cost ]', 'Cost', 'Price')).toBe('=[Price] * 2 + [Price]')
  })

  it('leaves other references, other case and string literals alone', () => {
    expect(renameFormulaReferences('=IF([cost] > 1, "[Cost]", [Costs])', 'Cost', 'Price')).toBe(
      '=IF([cost] > 1, "[Cost]", [Costs])',
    )
  })

  it('returns the same string when nothing changes', () => {
    const f = '=SUM([Qty])'
    expect(renameFormulaReferences(f, 'Cost', 'Price')).toBe(f)
  })
})

describe('columnLock', () => {
  it('locks the primary column for delete and retype', () => {
    const data = makeSheetData()
    expect(columnLock(data, 'c-task', 'delete')).toMatch(/primary column/)
    expect(columnLock(data, 'c-task', 'retype')).toMatch(/primary column/)
  })

  it('locks schedule columns while dependencies are enabled', () => {
    const data = makeSheetData()
    for (const id of ['c-start', 'c-end', 'c-dur', 'c-pred', 'c-pct']) {
      expect(columnLock(data, id, 'delete')).toMatch(/scheduling/)
      expect(columnLock(data, id, 'retype')).toMatch(/scheduling/)
    }
    expect(columnLock(data, 'c-status', 'delete')).toBeNull()
  })

  it('keeps schedule columns locked when dependencies are off (their role cannot be restored)', () => {
    const data = makeSheetData()
    data.sheet.dependenciesEnabled = false
    expect(columnLock(data, 'c-start', 'delete')).toMatch(/used for scheduling/)
    expect(columnLock(data, 'c-start', 'retype')).toMatch(/used for scheduling/)
    expect(columnLock(data, 'c-task', 'delete')).not.toBeNull()
  })
})
