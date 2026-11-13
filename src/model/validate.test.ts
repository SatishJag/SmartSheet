import { describe, expect, it } from 'vitest'
import { validateCell, type Column, type ColumnRole, type ColumnType } from './validate'

const ctx = { rowCount: 10, ownRowNumber: 3 }
const col = (type: ColumnType, extra: Partial<Column> = {}): Column => ({
  id: 'c1',
  title: 'Col',
  type,
  ...extra,
})
const role = (type: ColumnType, r: ColumnRole): Column => col(type, { role: r })

describe('empty input', () => {
  it.each([
    ['TEXT_NUMBER', null],
    ['DATE', null],
    ['CHECKBOX', false],
    ['PICKLIST', null],
    ['MULTI_PICKLIST', []],
    ['CONTACT_LIST', null],
    ['DURATION', null],
    ['PREDECESSOR', null],
  ] as [ColumnType, unknown][])('%s empty -> %j', (type, expected) => {
    expect(validateCell(col(type), '', ctx)).toEqual({ ok: true, value: expected })
    expect(validateCell(col(type), '   ', ctx)).toEqual({ ok: true, value: expected })
  })
  it('empty is valid in schedule role columns', () => {
    expect(validateCell(role('DURATION', 'duration'), '', ctx)).toEqual({ ok: true, value: null })
    expect(validateCell(role('TEXT_NUMBER', 'percentComplete'), '', ctx)).toEqual({ ok: true, value: null })
  })
})

describe('TEXT_NUMBER', () => {
  it('numeric strings become numbers', () => {
    expect(validateCell(col('TEXT_NUMBER'), '42', ctx)).toEqual({ ok: true, value: 42 })
    expect(validateCell(col('TEXT_NUMBER'), ' -3.5 ', ctx)).toEqual({ ok: true, value: -3.5 })
    expect(validateCell(col('TEXT_NUMBER'), '.5', ctx)).toEqual({ ok: true, value: 0.5 })
  })
  it('other strings stay text', () => {
    expect(validateCell(col('TEXT_NUMBER'), 'hello', ctx)).toEqual({ ok: true, value: 'hello' })
    expect(validateCell(col('TEXT_NUMBER'), '0x10', ctx)).toEqual({ ok: true, value: '0x10' })
    expect(validateCell(col('TEXT_NUMBER'), '1e3', ctx)).toEqual({ ok: true, value: '1e3' })
  })
  it('percentComplete accepts 0 and 100', () => {
    expect(validateCell(role('TEXT_NUMBER', 'percentComplete'), '0', ctx)).toEqual({ ok: true, value: 0 })
    expect(validateCell(role('TEXT_NUMBER', 'percentComplete'), '100', ctx)).toEqual({ ok: true, value: 100 })
    expect(validateCell(role('TEXT_NUMBER', 'percentComplete'), '50%', ctx)).toEqual({ ok: true, value: 50 })
  })
  it('percentComplete rejects out of range and non-numbers', () => {
    expect(validateCell(role('TEXT_NUMBER', 'percentComplete'), '101', ctx).ok).toBe(false)
    expect(validateCell(role('TEXT_NUMBER', 'percentComplete'), '-1', ctx).ok).toBe(false)
    expect(validateCell(role('TEXT_NUMBER', 'percentComplete'), 'abc', ctx).ok).toBe(false)
  })
})

describe('DATE', () => {
  it('accepts a real date', () => {
    expect(validateCell(col('DATE'), '2026-11-09', ctx)).toEqual({ ok: true, value: '2026-11-09' })
  })
  it('rejects text', () => {
    expect(validateCell(col('DATE'), 'banana', ctx).ok).toBe(false)
  })
  it('rejects impossible dates', () => {
    expect(validateCell(col('DATE'), '2026-02-30', ctx).ok).toBe(false)
    expect(validateCell(col('DATE'), '2026-13-01', ctx).ok).toBe(false)
  })
  it('accepts leap day only in leap years', () => {
    expect(validateCell(col('DATE'), '2028-02-29', ctx).ok).toBe(true)
    expect(validateCell(col('DATE'), '2026-02-29', ctx).ok).toBe(false)
  })
  it('accepts dates only from 1970-01-01 to 2100-12-31', () => {
    expect(validateCell(col('DATE'), '1970-01-01', ctx).ok).toBe(true)
    expect(validateCell(col('DATE'), '2100-12-31', ctx).ok).toBe(true)
    const msg = { ok: false, error: 'Enter a date between 1970-01-01 and 2100-12-31' }
    expect(validateCell(col('DATE'), '9999-12-31', ctx)).toEqual(msg)
    expect(validateCell(col('DATE'), '1969-12-31', ctx)).toEqual(msg)
    expect(validateCell(role('DATE', 'start'), '2101-01-01', ctx)).toEqual(msg)
  })
  it('start/end roles follow the same rule', () => {
    expect(validateCell(role('DATE', 'start'), '2026-11-09', ctx).ok).toBe(true)
    expect(validateCell(role('DATE', 'end'), 'banana', ctx).ok).toBe(false)
  })
})

describe('CHECKBOX', () => {
  it('parses true/false case-insensitively', () => {
    expect(validateCell(col('CHECKBOX'), 'true', ctx)).toEqual({ ok: true, value: true })
    expect(validateCell(col('CHECKBOX'), 'FALSE', ctx)).toEqual({ ok: true, value: false })
  })
  it('rejects anything else', () => {
    expect(validateCell(col('CHECKBOX'), 'yes', ctx).ok).toBe(false)
  })
  it('rejects formulas, which a checkbox cannot show or edit', () => {
    expect(validateCell(col('CHECKBOX'), '=1+2', ctx)).toEqual({ ok: false, error: 'Checkbox must be true or false' })
  })
})

describe('PICKLIST', () => {
  const c = col('PICKLIST', { options: ['Open', 'Done'] })
  it('accepts an option', () => {
    expect(validateCell(c, 'Open', ctx)).toEqual({ ok: true, value: 'Open' })
  })
  it('rejects a non-option and names the allowed options', () => {
    const r = validateCell(c, 'Nope', ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Open, Done')
  })
  it('is case-sensitive', () => {
    expect(validateCell(c, 'open', ctx).ok).toBe(false)
  })
  it('undefined options fail every non-empty value', () => {
    expect(validateCell(col('PICKLIST'), 'x', ctx).ok).toBe(false)
  })
})

describe('MULTI_PICKLIST', () => {
  const c = col('MULTI_PICKLIST', { options: ['A', 'B', 'C'] })
  it('parses a list', () => {
    expect(validateCell(c, 'A, C', ctx)).toEqual({ ok: true, value: ['A', 'C'] })
  })
  it('de-duplicates keeping order', () => {
    expect(validateCell(c, 'B, A, B, A', ctx)).toEqual({ ok: true, value: ['B', 'A'] })
  })
  it('names the bad item', () => {
    const r = validateCell(c, 'A, Z', ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Z')
  })
})

describe('CONTACT_LIST', () => {
  it('accepts an email', () => {
    expect(validateCell(col('CONTACT_LIST'), 'a@b.co', ctx)).toEqual({ ok: true, value: 'a@b.co' })
  })
  it('rejects a non-email', () => {
    expect(validateCell(col('CONTACT_LIST'), 'not an email', ctx).ok).toBe(false)
  })
})

describe('DURATION', () => {
  it('accepts and canonicalises', () => {
    expect(validateCell(col('DURATION'), '4d', ctx)).toEqual({ ok: true, value: '4d' })
    expect(validateCell(col('DURATION'), '4D', ctx)).toEqual({ ok: true, value: '4d' })
  })
  it('rejects garbage', () => {
    expect(validateCell(col('DURATION'), 'x', ctx).ok).toBe(false)
  })
  it('respects hoursPerDay', () => {
    expect(validateCell(col('DURATION'), '10h', { ...ctx, hoursPerDay: 10 })).toEqual({ ok: true, value: '1d' })
  })
})

describe('PREDECESSOR', () => {
  it('accepts and canonicalises', () => {
    expect(validateCell(col('PREDECESSOR'), '2', ctx)).toEqual({ ok: true, value: '2FS' })
    expect(validateCell(col('PREDECESSOR'), '2ss +1d, 5', ctx)).toEqual({ ok: true, value: '2SS +1d, 5FS' })
  })
  it('rejects a row that does not exist', () => {
    const r = validateCell(col('PREDECESSOR'), '99', ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('99')
  })
  it('accepts the last row', () => {
    expect(validateCell(col('PREDECESSOR'), '10', ctx).ok).toBe(true)
  })
  it('rejects depending on itself', () => {
    expect(validateCell(col('PREDECESSOR'), '3', ctx).ok).toBe(false)
  })
  it('returns the parser error for bad syntax', () => {
    expect(validateCell(col('PREDECESSOR'), 'abc', ctx).ok).toBe(false)
  })
})

describe('formulas', () => {
  it('pass through on ordinary columns', () => {
    expect(validateCell(col('TEXT_NUMBER'), '=SUM(1,2)', ctx)).toEqual({ ok: true, value: '=SUM(1,2)' })
    expect(validateCell(col('DATE'), '=TODAY()', ctx)).toEqual({ ok: true, value: '=TODAY()' })
  })
  it.each([
    ['DATE', 'start'],
    ['DATE', 'end'],
    ['DURATION', 'duration'],
    ['PREDECESSOR', 'predecessor'],
    ['TEXT_NUMBER', 'percentComplete'],
  ] as [ColumnType, ColumnRole][])('are rejected in %s %s columns', (type, r) => {
    const res = validateCell(role(type, r), '=1+1', ctx)
    expect(res).toEqual({ ok: false, error: `Formulas are not allowed in ${r} columns` })
  })
  it('are allowed in schedule columns when dependencies are disabled', () => {
    const res = validateCell(role('DURATION', 'duration'), '=1+1', { ...ctx, dependenciesEnabled: false })
    expect(res).toEqual({ ok: true, value: '=1+1' })
  })
  it('are allowed in a status role column', () => {
    expect(validateCell(role('PICKLIST', 'status'), '=1', ctx)).toEqual({ ok: true, value: '=1' })
  })
})
