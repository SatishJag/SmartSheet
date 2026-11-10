import { describe, expect, it } from 'vitest'
import { evaluate, type FormulaContext } from './evaluate'

function makeCtx(
  data: Record<string, unknown[]>,
  rowIndex = 0,
  today?: string,
): FormulaContext {
  const rowCount = Math.max(0, ...Object.values(data).map((c) => c.length))
  return {
    cell: (title, row) => data[title]?.[row],
    rowIndex,
    rowCount,
    hasColumn: (title) => title in data,
    today,
  }
}

const empty = makeCtx({})

function ok(formula: string, ctx: FormulaContext = empty) {
  const r = evaluate(formula, ctx)
  if (!r.ok) throw new Error(`expected ok but got error: ${r.error}`)
  return r.value
}

function err(formula: string, ctx: FormulaContext = empty) {
  const r = evaluate(formula, ctx)
  if (r.ok) throw new Error(`expected error but got value: ${String(r.value)}`)
  return r.error
}

describe('arithmetic', () => {
  it('respects precedence', () => {
    expect(ok('=1+2*3')).toBe(7)
  })
  it('respects parentheses', () => {
    expect(ok('=(1+2)*3')).toBe(9)
  })
  it('supports unary minus', () => {
    expect(ok('=-5+2')).toBe(-3)
    expect(ok('=-(2+3)')).toBe(-5)
    expect(ok('=3 - -2')).toBe(5)
  })
  it('supports division and decimals', () => {
    expect(ok('=10/4')).toBe(2.5)
    expect(ok('=1.5*2')).toBe(3)
  })
  it('is left associative', () => {
    expect(ok('=10-4-3')).toBe(3)
    expect(ok('=24/4/3')).toBe(2)
  })
  it('errors on division by zero', () => {
    expect(err('=1/0')).toMatch(/division by zero/i)
  })
  it('errors on arithmetic with non-numeric strings', () => {
    expect(err('="abc"+1')).toMatch(/number/i)
  })
})

describe('literals and comparisons', () => {
  it('parses TRUE and FALSE case-insensitively', () => {
    expect(ok('=TRUE')).toBe(true)
    expect(ok('=false')).toBe(false)
  })
  it('compares numbers', () => {
    expect(ok('=3>2')).toBe(true)
    expect(ok('=3<=2')).toBe(false)
    expect(ok('=2>=2')).toBe(true)
    expect(ok('=2=2')).toBe(true)
    expect(ok('=2<>2')).toBe(false)
    expect(ok('=1+1<3')).toBe(true)
  })
  it('compares strings as strings, including ISO dates', () => {
    expect(ok('="abc"="abc"')).toBe(true)
    expect(ok('="2026-11-09"<"2026-11-10"')).toBe(true)
    expect(ok('="b">"a"')).toBe(true)
    expect(ok('="a"<>"b"')).toBe(true)
  })
  it('returns a string literal', () => {
    expect(ok('="hello"')).toBe('hello')
  })
})

describe('column references', () => {
  it('reads the current row cell', () => {
    const ctx = makeCtx({ Qty: [1, 5], Rate: [2, 3] }, 1)
    expect(ok('=[Qty]*[Rate]', ctx)).toBe(15)
  })
  it('supports titles with spaces', () => {
    const ctx = makeCtx({ 'Unit Cost': [4] })
    expect(ok('=[Unit Cost]+1', ctx)).toBe(5)
  })
  it('coerces numeric strings to numbers in arithmetic', () => {
    const ctx = makeCtx({ Cost: ['12.5'] })
    expect(ok('=[Cost]*2', ctx)).toBe(25)
  })
  it('treats empty and undefined cells as 0 in arithmetic', () => {
    const ctx = makeCtx({ A: [undefined, ''], B: [null, 4] })
    expect(ok('=[A]+5', ctx)).toBe(5)
    expect(ok('=[B]+5', ctx)).toBe(5)
    const ctx2 = makeCtx({ A: [undefined, ''] }, 1)
    expect(ok('=[A]+5', ctx2)).toBe(5)
  })
  it('returns ok:false naming an unknown column', () => {
    const r = evaluate('=[Nope]+1', makeCtx({ Cost: [1] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Nope')
  })
  it('returns a text cell value as a string', () => {
    const ctx = makeCtx({ Name: ['Slab'] })
    expect(ok('=[Name]', ctx)).toBe('Slab')
  })
  it('errors on an unterminated column reference', () => {
    expect(err('=[Cost')).toMatch(/column|bracket|syntax/i)
  })
})

describe('SUM', () => {
  it('sums a whole column', () => {
    const ctx = makeCtx({ Cost: [1, 2, 3] })
    expect(ok('=SUM([Cost])', ctx)).toBe(6)
  })
  it('skips text and empty cells in a column', () => {
    const ctx = makeCtx({ Cost: [1, 'n/a', undefined, '', 2, null] })
    expect(ok('=SUM([Cost])', ctx)).toBe(3)
  })
  it('sums numbers and expressions', () => {
    expect(ok('=SUM(1, 2, 3*2)')).toBe(9)
  })
  it('mixes columns and numbers', () => {
    const ctx = makeCtx({ Cost: [1, 2, 3] })
    expect(ok('=SUM([Cost], 10)', ctx)).toBe(16)
  })
  it('errors on an unknown column', () => {
    const r = evaluate('=SUM([Missing])', makeCtx({ Cost: [1] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Missing')
  })
  it('is case-insensitive', () => {
    const ctx = makeCtx({ Cost: [1, 2] })
    expect(ok('=sum([Cost])', ctx)).toBe(3)
  })
})

describe('IF', () => {
  it('chooses the true branch', () => {
    const ctx = makeCtx({ Qty: [3] })
    expect(ok('=IF([Qty]>2, "big", "small")', ctx)).toBe('big')
  })
  it('chooses the false branch', () => {
    const ctx = makeCtx({ Qty: [1] })
    expect(ok('=IF([Qty]>2, "big", "small")', ctx)).toBe('small')
  })
  it('evaluates lazily', () => {
    expect(ok('=IF(TRUE, 1, 1/0)')).toBe(1)
    expect(ok('=IF(FALSE, 1/0, 2)')).toBe(2)
  })
  it('errors when the condition is not boolean', () => {
    expect(err('=IF("x", 1, 2)')).toMatch(/boolean|condition/i)
  })
  it('errors on wrong argument count', () => {
    expect(err('=IF(TRUE, 1)')).toMatch(/IF/)
  })
})

describe('TODAY and NETDAYS', () => {
  it('returns the injected today', () => {
    expect(ok('=TODAY()', makeCtx({}, 0, '2026-11-09'))).toBe('2026-11-09')
  })
  it('defaults to the real current UTC date', () => {
    const v = ok('=TODAY()')
    expect(v).toBe(new Date().toISOString().slice(0, 10))
  })
  it('counts Mon-Fri days after d1 up to and including d2', () => {
    expect(ok('=NETDAYS("2026-11-09","2026-11-13")')).toBe(4)
  })
  it('skips weekends', () => {
    // Fri 2026-11-13 to Mon 2026-11-16 -> only Monday counts
    expect(ok('=NETDAYS("2026-11-13","2026-11-16")')).toBe(1)
    expect(ok('=NETDAYS("2026-11-09","2026-11-16")')).toBe(5)
  })
  it('returns 0 for the same date', () => {
    expect(ok('=NETDAYS("2026-11-09","2026-11-09")')).toBe(0)
  })
  it('returns the negative of the swapped count when d2 is before d1', () => {
    expect(ok('=NETDAYS("2026-11-13","2026-11-09")')).toBe(-4)
  })
  it('works with TODAY() and column dates', () => {
    const ctx = makeCtx({ Finish: ['2026-11-13'] }, 0, '2026-11-09')
    expect(ok('=NETDAYS(TODAY(), [Finish])', ctx)).toBe(4)
  })
  it('errors on an invalid date', () => {
    expect(err('=NETDAYS("nope","2026-11-13")')).toMatch(/date/i)
    expect(err('=NETDAYS("2026-02-30","2026-11-13")')).toMatch(/date/i)
  })
  it('errors on wrong argument count', () => {
    expect(err('=NETDAYS("2026-11-09")')).toMatch(/NETDAYS/)
  })
})

describe('errors', () => {
  it('errors on unknown function with its name', () => {
    expect(err('=FOO(1)')).toMatch(/FOO/)
  })
  it('requires a leading =', () => {
    expect(err('1+2')).toMatch(/=/)
  })
  it('errors on unterminated string', () => {
    expect(err('="abc')).toMatch(/string|unterminated/i)
  })
  it('errors on stray tokens', () => {
    expect(err('=1 2')).toMatch(/unexpected/i)
    expect(err('=1 +')).toMatch(/unexpected|end/i)
    expect(err('=)')).toMatch(/unexpected/i)
    expect(err('=1 # 2')).toMatch(/unexpected|character/i)
  })
  it('errors on empty expression', () => {
    expect(err('=')).toMatch(/unexpected|empty|end/i)
  })
  it('errors on unclosed parenthesis', () => {
    expect(err('=(1+2')).toMatch(/\)|paren/i)
  })
  it('never throws', () => {
    const throwing: FormulaContext = {
      cell: () => {
        throw new Error('boom')
      },
      rowIndex: 0,
      rowCount: 1,
      hasColumn: () => true,
    }
    expect(() => evaluate('=[A]+1', throwing)).not.toThrow()
    expect(evaluate('=[A]+1', throwing).ok).toBe(false)
  })
})
