import { describe, expect, it } from 'vitest'
import { evaluate, type CellKind, type Dest, type FormulaContext, type FormulaValue } from './evaluate'
import { matchFunctions, FUNCTIONS } from './registry'
import { FUNCS } from './functions'

/** A small in-memory sheet: columns by title (values per row), kinds, and an optional row tree (parent index per row). */
function makeCtx(
  data: Record<string, unknown[]>,
  opts: { row?: number; today?: string; kinds?: Record<string, CellKind>; parents?: (number | null)[]; own?: string; dest?: Dest } = {},
): FormulaContext {
  const rowCount = Math.max(0, ...Object.values(data).map((c) => c.length), opts.parents?.length ?? 0)
  const parents = opts.parents ?? []
  return {
    cell: (title, row) => data[title]?.[row],
    rowIndex: opts.row ?? 0,
    rowCount,
    hasColumn: (title) => title in data,
    cellKind: (title) => opts.kinds?.[title],
    ownColumn: opts.own,
    parent: (i) => parents[i] ?? null,
    children: (i) => parents.flatMap((p, r) => (p === i ? [r] : [])),
    today: opts.today,
    dest: opts.dest,
  }
}

const empty = makeCtx({})

function ok(formula: string, ctx: FormulaContext = empty): FormulaValue {
  const r = evaluate(formula, ctx)
  if (!r.ok) throw new Error(`expected ok but got ${r.error}: ${r.message}`)
  return r.value
}

/** The error name, e.g. '#DIVIDE BY ZERO'. */
function err(formula: string, ctx: FormulaContext = empty): string {
  const r = evaluate(formula, ctx)
  if (r.ok) throw new Error(`expected an error but got value: ${String(r.value)}`)
  return r.error
}

const message = (formula: string, ctx: FormulaContext = empty) => {
  const r = evaluate(formula, ctx)
  return r.ok ? '' : r.message
}

describe('operators and precedence', () => {
  it.each([
    ['=1+2*3', 7],
    ['=(1+2)*3', 9],
    ['=10/4', 2.5],
    ['=10-4-3', 3],
    ['=24/4/3', 2],
    ['=2^10', 1024],
    ['=2^3^2', 64], // left to right, as in Excel
    ['=-2^2', 4], // unary minus binds tighter than ^
    ['=-5+2', -3],
    ['=-(2+3)', -5],
    ['=3 - -2', 5],
    ['=+3', 3],
    ['=1.5*2', 3],
    ['=.5+.25', 0.75],
    ['=0.1+0.2', 0.3], // 15 significant digits
  ])('%s = %s', (f, v) => expect(ok(f)).toBe(v))

  it('+ concatenates when either side is text, there is no &', () => {
    expect(ok('="a"+1')).toBe('a1')
    expect(ok('=1+"a"')).toBe('1a')
    expect(ok('=1+"2"')).toBe('12')
    expect(ok('="1"+"2"')).toBe('12')
    expect(err('="a"&"b"')).toBe('#UNPARSEABLE')
    expect(err('=1&2')).toBe('#UNPARSEABLE')
    expect(err('=5%')).toBe('#UNPARSEABLE')
  })

  it('comparisons and logic return booleans', () => {
    expect(ok('=3>2')).toBe(true)
    expect(ok('=3<=2')).toBe(false)
    expect(ok('=2>=2')).toBe(true)
    expect(ok('=2<>2')).toBe(false)
    expect(ok('="a"="A"')).toBe(true) // case-insensitive
    expect(ok('="b">"a"')).toBe(true)
    expect(ok('=1+1<3')).toBe(true)
    expect(ok('=TRUE')).toBe(true)
    expect(ok('=false')).toBe(false)
    expect(ok('=AND(TRUE,FALSE)')).toBe(false)
    expect(ok('=OR(1=2,2=2)')).toBe(true)
    expect(ok('=NOT(FALSE)')).toBe(true)
    expect(ok('=AND(1,1)')).toBe(true) // 1/0 count as booleans, like IF
  })

  it('compares numbers stored as text as numbers, other text by order', () => {
    const ctx = makeCtx({ A: ['10'], B: ['9'] })
    expect(ok('=[A]>[B]', ctx)).toBe(true)
    expect(ok('=[A]="10.0"', ctx)).toBe(true)
    expect(ok('="10x">"9x"')).toBe(false) // not numeric: text order
  })

  it('compares dates, and ISO text against a date', () => {
    expect(ok('=DATE(2026,3,15)>DATE(2026,3,1)')).toBe(true)
    expect(ok('=DATE(2026,3,15)="2026-03-15"')).toBe(true)
  })

  it('a number never equals non-numeric text; ordering them is an error', () => {
    expect(ok('=1="a"')).toBe(false)
    expect(ok('=1<>"a"')).toBe(true)
    expect(err('=1<"a"')).toBe('#INVALID DATA TYPE')
  })
})

describe('result types and the destination column', () => {
  const dest = (formula: string, d: Dest, ctx: FormulaContext = empty) => {
    const r = evaluate(formula, { ...ctx, dest: d })
    return r.ok ? r.value : r.error
  }
  it('a boolean fits only a checkbox', () => {
    expect(dest('=1=1', 'B')).toBe(true)
    expect(dest('=1=1', 'T')).toBe('#INVALID COLUMN VALUE')
    expect(dest('=1=1', 'D')).toBe('#DATE EXPECTED')
  })
  it('a date fits only a date column', () => {
    expect(dest('=DATE(2026,3,1)', 'D')).toBe('2026-03-01')
    expect(dest('=DATE(2026,3,1)', 'T')).toBe('#INVALID COLUMN VALUE')
    expect(dest('=DATE(2026,3,1)', 'B')).toBe('#BOOLEAN EXPECTED')
  })
  it('a number fits a checkbox only as 0/1 and a date column only as 0', () => {
    expect(dest('=1', 'B')).toBe(true)
    expect(dest('=0', 'B')).toBe(false)
    expect(dest('=2', 'B')).toBe('#BOOLEAN EXPECTED')
    expect(dest('=0', 'D')).toBe(null)
    expect(dest('=1', 'D')).toBe('#DATE EXPECTED')
  })
  it('text fits anywhere, an empty result is null (false in a checkbox)', () => {
    expect(dest('="x"', 'B')).toBe('x')
    expect(dest('=IF(FALSE,1)', 'T')).toBe(null)
    expect(dest('=IF(FALSE,1)', 'B')).toBe(false)
  })
  it('a duration column gets numbers as days', () => {
    expect(dest('=3', 'U')).toBe('3d')
    expect(dest('=1=1', 'U')).toBe('#INVALID COLUMN VALUE')
  })
  it('keeps 15 significant digits and never returns -0', () => {
    expect(ok('=1/3')).toBe(0.333333333333333)
    expect(Object.is(ok('=-0'), -0)).toBe(false)
  })
})

describe('errors', () => {
  it.each([
    ['=10/0', '#DIVIDE BY ZERO'],
    ['=MOD(1,0)', '#DIVIDE BY ZERO'],
    ['=AVG()', '#INCORRECT ARGUMENT SET'],
    ['=FOO(1)', '#UNPARSEABLE'],
    ['=1+', '#UNPARSEABLE'],
    ['=', '#UNPARSEABLE'],
    ['=(1+2', '#UNPARSEABLE'],
    ['=)', '#UNPARSEABLE'],
    ['=1 2', '#UNPARSEABLE'],
    ['=1 # 2', '#UNPARSEABLE'],
    ['="abc', '#UNPARSEABLE'],
    ['=[Cost', '#UNPARSEABLE'],
    ['=SQRT(1,2)', '#INCORRECT ARGUMENT SET'],
    ['=CEILING(2.1)', '#INCORRECT ARGUMENT SET'],
    ['=WEEKDAY(DATE(2026,3,15),2)', '#INCORRECT ARGUMENT SET'],
    ['=IF(TRUE)', '#INCORRECT ARGUMENT SET'],
    ['="a"*2', '#INVALID DATA TYPE'],
    ['=-"a"', '#INVALID DATA TYPE'],
    ['=IF("a",1,2)', '#INVALID DATA TYPE'],
    ['=IF(2,1,2)', '#INVALID DATA TYPE'],
    ['=TRUE+1', '#INVALID OPERATION'],
    ['=DATE(2026,3,1)+DATE(2026,3,2)', '#INVALID OPERATION'],
    ['=DATE(2026,3,1)*2', '#INVALID OPERATION'],
    ['=5-DATE(2026,3,1)', '#INVALID OPERATION'],
    ['=DATE(2026,13,1)', '#INVALID VALUE'],
    ['=VALUE("x")', '#INVALID VALUE'],
    ['=CHAR(0)', '#INVALID VALUE'],
    ['={1,2}', '#INVALID REF'],
    ['={Other Sheet}', '#INVALID REF'],
    ['=SUM({})', '#INVALID REF'],
  ])('%s is %s', (f, name) => expect(err(f)).toBe(name))

  it('gives a plain-language message to explain the error', () => {
    expect(message('=1/0')).toMatch(/zero/i)
    expect(message('=FOO(1)')).toMatch(/FOO/)
    expect(message('=SQRT(1,2)')).toMatch(/SQRT expects 1 argument but got 2/)
    expect(message('=[Nope]+1', makeCtx({ Cost: [1] }))).toContain('Nope')
  })

  it('requires a leading =', () => {
    expect(err('1+2')).toBe('#UNPARSEABLE')
    expect(message('1+2')).toMatch(/=/)
  })

  it('an unknown column is #UNPARSEABLE and names the column', () => {
    const ctx = makeCtx({ Cost: [1] })
    expect(err('=[Nope]+1', ctx)).toBe('#UNPARSEABLE')
    expect(err('=SUM([Missing])', ctx)).toBe('#UNPARSEABLE')
    expect(message('=SUM([Missing])', ctx)).toContain('Missing')
  })

  it('never throws, even if reading a cell does', () => {
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

  it('rejects nesting deeper than 100 with a clear error instead of overflowing the stack', () => {
    expect(message('=' + '('.repeat(101) + '1' + ')'.repeat(101))).toBe('Formula is nested too deeply')
    expect(message('=' + '-'.repeat(101) + '1')).toBe('Formula is nested too deeply')
    expect(message('=' + 'IF(TRUE,'.repeat(101) + '1' + ',0)'.repeat(101))).toBe('Formula is nested too deeply')
    expect(message('=' + '('.repeat(5000) + '1' + ')'.repeat(5000))).toBe('Formula is nested too deeply')
    expect(ok('=' + '('.repeat(90) + '1' + ')'.repeat(90))).toBe(1)
  })
})

describe('references', () => {
  const cols = {
    Qty: [1, 5, 3],
    Rate: [2, 3, 4],
    'Unit Cost': [4, 6, 8],
    Name: ['Slab', 'Beam', 'Pier'],
    Num: [1, 2, 3, null],
    Flag: [true, false, true],
  }
  const ctx = (row: number) => makeCtx(cols, { row, kinds: { Flag: 'checkbox' } })

  it('[Title] is the same-row cell', () => {
    expect(ok('=[Qty]*[Rate]', ctx(1))).toBe(15)
    expect(ok('=[Unit Cost]+1', ctx(0))).toBe(5)
    expect(ok('=[Name]', ctx(2))).toBe('Pier')
  })
  it('Col@row, [Title]@row and [Title]N', () => {
    expect(ok('=Qty@row*Rate@row', ctx(1))).toBe(15)
    expect(ok('=[Unit Cost]@row+1', ctx(2))).toBe(9)
    expect(ok('=[Qty]3', ctx(0))).toBe(3) // a specific row (1-based)
    expect(err('=[Qty]9', ctx(0))).toBe('#INVALID REF')
    expect(err('=[Qty]0', ctx(0))).toBe('#INVALID REF')
  })
  it('whole-column ranges: Col:Col and [Col]:[Col]', () => {
    expect(ok('=SUM(Qty:Qty)', ctx(0))).toBe(9)
    expect(ok('=SUM([Qty]:[Qty])', ctx(0))).toBe(9)
    expect(ok('=SUM([Qty]2:[Qty]3)', ctx(0))).toBe(8)
    expect(err('=SUM([Qty]:[Rate])', ctx(0))).toBe('#INVALID REF')
    expect(err('=SUM([Qty]2:[Qty])', ctx(0))).toBe('#UNPARSEABLE')
  })
  it('a bare [Column] argument of an aggregate is the whole column (existing behaviour)', () => {
    expect(ok('=SUM([Qty])', ctx(0))).toBe(9)
    expect(ok('=SUM([Qty], 10)', ctx(0))).toBe(19)
    expect(ok('=SUM([Qty])+[Qty]', ctx(1))).toBe(14) // still the cell outside an aggregate
  })
  it('titles resolve through the context, which may ignore case', () => {
    const c = makeCtx({ Cost: [1] })
    expect(evaluate('=[Cost]+1', c)).toEqual({ ok: true, value: 2 })
  })
  it('treats empty and undefined cells as 0 in arithmetic', () => {
    const c = makeCtx({ A: [undefined, ''], B: [null, 4] })
    expect(ok('=[A]+5', c)).toBe(5)
    expect(ok('=[B]+5', c)).toBe(5)
    expect(ok('=[A]+5', { ...c, rowIndex: 1 })).toBe(5)
  })
  it('coerces numbers stored as text in arithmetic', () => {
    expect(ok('=[Cost]*2', makeCtx({ Cost: ['12.5'] }))).toBe(25)
  })
  it('checkbox cells are booleans, unchecked is false', () => {
    expect(ok('=IF(Flag@row,"y","n")', ctx(0))).toBe('y')
    expect(ok('=IF(Flag@row,"y","n")', ctx(1))).toBe('n')
    expect(err('=Flag@row+1', ctx(0))).toBe('#INVALID OPERATION')
  })
  it('cross-sheet {references} are reserved: #INVALID REF', () => {
    expect(err('=COUNTIF({Status Sheet}, "x")')).toBe('#INVALID REF')
  })
})

describe('math', () => {
  it.each([
    ['=ABS(-3.5)', 3.5],
    ['=ROUND(2.567,2)', 2.57],
    ['=ROUND(2.5)', 3],
    ['=ROUND(-2.5)', -3], // half away from zero
    ['=ROUND(2.675,2)', 2.68],
    ['=ROUND(1234.5,-2)', 1200],
    ['=ROUNDUP(2.11,1)', 2.2],
    ['=ROUNDUP(-2.11,1)', -2.2],
    ['=ROUNDDOWN(2.99,1)', 2.9],
    ['=ROUNDDOWN(-2.99,1)', -2.9],
    ['=ROUNDUP(2.1*10,0)', 21], // no 21.000000000000004 noise
    ['=INT(-2.5)', -2], // truncates toward zero
    ['=INT(2.9)', 2],
    ['=MOD(10,3)', 1],
    ['=MOD(-10,3)', 2], // sign of the divisor
    ['=MOD(10,-3)', -2],
    ['=CEILING(2.1,0.5)', 2.5],
    ['=FLOOR(2.9,0.5)', 2.5],
    ['=SQRT(16)', 4],
    ['=POWER(2,8)', 256],
  ])('%s = %s', (f, v) => expect(ok(f)).toBe(v))
  it('SQRT of a negative number is #INVALID VALUE', () => expect(err('=SQRT(-1)')).toBe('#INVALID VALUE'))
  it('a blank cell counts as 0', () => {
    expect(ok('=ABS(Num@row)', makeCtx({ Num: [null] }))).toBe(0)
  })
})

describe('aggregates', () => {
  const ctx = makeCtx({ Cost: [1, 'n/a', undefined, '', 2, null], Qty: [5, 1, 3, 1, 1, 1], When: ['2026-03-05', '2026-03-01', null] }, {
    kinds: { When: 'date' },
  })
  it('SUM adds numbers, skipping text and blanks in a column', () => {
    expect(ok('=SUM(Cost:Cost)', ctx)).toBe(3)
    expect(ok('=SUM(1, 2, 3*2)')).toBe(9)
    expect(ok('=SUM(Cost:Cost, 10)', ctx)).toBe(13)
    expect(ok('=sum(Cost:Cost)', ctx)).toBe(3) // case-insensitive
  })
  it('typed-in non-numbers are errors in SUM/AVG', () => {
    expect(err('=SUM(1,"a")')).toBe('#INVALID DATA TYPE')
    expect(err('=AVG(TRUE)')).toBe('#INVALID DATA TYPE')
  })
  it('AVG, MIN, MAX, MEDIAN', () => {
    expect(ok('=AVG(1,2,3,4)')).toBe(2.5)
    expect(ok('=AVG(Cost:Cost)', ctx)).toBe(1.5)
    expect(ok('=MIN(3,1,2)')).toBe(1)
    expect(ok('=MAX(3,1,2)')).toBe(3)
    expect(ok('=MEDIAN(1,3,2,10)')).toBe(2.5)
    expect(ok('=MEDIAN(5,1,3)')).toBe(3)
    expect(err('=AVG(Nums:Nums)', makeCtx({ Nums: [] }))).toBe('#DIVIDE BY ZERO')
    expect(ok('=MIN(Nums:Nums)', makeCtx({ Nums: [] }))).toBe(0)
    expect(err('=MEDIAN(Nums:Nums)', makeCtx({ Nums: [] }))).toBe('#INVALID VALUE')
  })
  it('MIN and MAX of dates are dates', () => {
    expect(ok('=MAX(When:When)', { ...ctx, dest: 'D' })).toBe('2026-03-05')
    expect(ok('=MIN(When:When)', { ...ctx, dest: 'D' })).toBe('2026-03-01')
    expect(err('=MAX(When:When, 1)', ctx)).toBe('#INVALID DATA TYPE')
  })
  it('COUNT counts what is not blank', () => {
    expect(ok('=COUNT(1,2,"a")')).toBe(3)
    expect(ok('=COUNT(Cost:Cost)', ctx)).toBe(3) // 1, "n/a", 2
    expect(ok('=COUNT(When:When)', ctx)).toBe(2)
  })
})

describe('conditional aggregates', () => {
  const ctx = makeCtx({
    Num: [1, 2, 3, null],
    Num2: [4, 5, 6, 7],
    Txt: ['apple', 'pear', 'plum', 'Apricot'],
    Status: ['Done', 'done', 'Open', null],
    When: ['2026-03-01', '2026-03-10', null, '2026-04-01'],
  }, { kinds: { When: 'date' } })
  it('COUNTIF / SUMIF / AVERAGEIF with comparison criteria', () => {
    expect(ok('=COUNTIF(Num:Num,">1")', ctx)).toBe(2)
    expect(ok('=COUNTIF(Num:Num,">=2")', ctx)).toBe(2)
    expect(ok('=COUNTIF(Num:Num,2)', ctx)).toBe(1)
    expect(ok('=COUNTIF(Num:Num,"<>2")', ctx)).toBe(3)
    expect(ok('=SUMIF(Num:Num,">1")', ctx)).toBe(5)
    expect(ok('=AVERAGEIF(Num:Num,">0")', ctx)).toBe(2)
    expect(err('=AVERAGEIF(Num:Num,">9")', ctx)).toBe('#DIVIDE BY ZERO')
  })
  it('text criteria are case-insensitive; * and ? are wildcards (ours)', () => {
    expect(ok('=COUNTIF(Status:Status,"done")', ctx)).toBe(2)
    expect(ok('=COUNTIF(Status:Status,"<>done")', ctx)).toBe(2) // Open and the blank
    expect(ok('=COUNTIF(Txt:Txt,"a*")', ctx)).toBe(2)
    expect(ok('=COUNTIF(Txt:Txt,"p??r")', ctx)).toBe(1)
    expect(ok('=COUNTIF(Status:Status,"")', ctx)).toBe(1) // blanks
  })
  it('date criteria', () => {
    expect(ok('=COUNTIF(When:When,">2026-03-05")', ctx)).toBe(2)
    expect(ok('=COUNTIF(When:When,DATE(2026,3,1))', ctx)).toBe(1)
  })
  it('SUMIF with a separate sum range, and the *IFS family (ours)', () => {
    expect(ok('=SUMIF(Num:Num,">1",Num2:Num2)', ctx)).toBe(11)
    expect(ok('=COUNTIFS(Num:Num,">0",Num2:Num2,">4")', ctx)).toBe(2)
    expect(ok('=SUMIFS(Num2:Num2,Num:Num,">1",Status:Status,"open")', ctx)).toBe(6)
    expect(ok('=AVERAGEIFS(Num2:Num2,Num:Num,">1")', ctx)).toBe(5.5)
    expect(err('=SUMIFS(Num2:Num2,Num:Num)', ctx)).toBe('#INCORRECT ARGUMENT SET')
    expect(err('=COUNTIFS(Num:Num,">0",Num2:Num2)', ctx)).toBe('#INCORRECT ARGUMENT SET')
    expect(err('=SUMIF([Num]1:[Num]2,">0",Num2:Num2)', ctx)).toBe('#INCORRECT ARGUMENT SET') // sizes differ
  })
})

describe('IF and logic', () => {
  it('chooses the true or the false branch', () => {
    const ctx = (q: number) => makeCtx({ Qty: [q] })
    expect(ok('=IF([Qty]>2, "big", "small")', ctx(3))).toBe('big')
    expect(ok('=IF([Qty]>2, "big", "small")', ctx(1))).toBe('small')
  })
  it('evaluates lazily', () => {
    expect(ok('=IF(TRUE, 1, 1/0)')).toBe(1)
    expect(ok('=IF(FALSE, 1/0, 2)')).toBe(2)
  })
  it('IF(false, a) with no else is blank', () => expect(ok('=IF(1>2,"y")')).toBe(null))
  it('the condition is a boolean or exactly 0 or 1', () => {
    expect(ok('=IF(1,"y","n")')).toBe('y')
    expect(ok('=IF(0,"y","n")')).toBe('n')
    expect(err('=IF("",1,2)')).toBe('#INVALID DATA TYPE')
    expect(err('=IF(Num@row,1,2)', makeCtx({ Num: [null] }))).toBe('#INVALID DATA TYPE') // a blank cell too
  })
  it('IFERROR and ISERROR catch any error', () => {
    expect(ok('=IFERROR(1/0,"err")')).toBe('err')
    expect(ok('=IFERROR(5,"err")')).toBe(5)
    expect(ok('=IFERROR(1/0)')).toBe(null)
    expect(ok('=IFERROR(SUM({}),"ref")')).toBe('ref')
    expect(ok('=ISERROR(1/0)')).toBe(true)
    expect(ok('=ISERROR(1)')).toBe(false)
  })
  it('checks', () => {
    const ctx = makeCtx({ Num: [null, 1], Txt: ['', 'a'], Dt: [null, '2026-03-01'] }, { kinds: { Dt: 'date' } })
    expect(ok('=ISBLANK(Num@row)', ctx)).toBe(true)
    expect(ok('=ISBLANK(Txt@row)', ctx)).toBe(true)
    expect(ok('=ISBLANK(Dt@row)', ctx)).toBe(true)
    expect(ok('=ISBLANK(Num@row)', { ...ctx, rowIndex: 1 })).toBe(false)
    expect(ok('=ISNUMBER(1)')).toBe(true)
    expect(ok('=ISNUMBER("1")')).toBe(false)
    expect(ok('=ISTEXT("a")')).toBe(true)
    expect(ok('=ISTEXT(1)')).toBe(false)
    expect(ok('=ISBOOLEAN(TRUE)')).toBe(true)
    expect(ok('=ISDATE(Dt@row)', { ...ctx, rowIndex: 1 })).toBe(true)
    expect(ok('=ISDATE("x")')).toBe(false)
  })
})

describe('text', () => {
  it.each([
    ['=LEFT("hello",2)', 'he'],
    ['=LEFT("hello")', 'h'],
    ['=RIGHT("hello",2)', 'lo'],
    ['=RIGHT("hello",0)', ''],
    ['=MID("hello",2,3)', 'ell'],
    ['=LEN("hello")', 5],
    ['=LEN(12345)', 5],
    ['=UPPER("a")', 'A'],
    ['=LOWER("A")', 'a'],
    ['=FIND("l","hello")', 3],
    ['=FIND("l","hello",4)', 4],
    ['=FIND("z","hello")', 0],
    ['=SUBSTITUTE("aXbXc","X","-")', 'a-b-c'],
    ['=SUBSTITUTE("aXbXc","X","-",2)', 'aXb-c'],
    ['=REPLACE("hello",2,2,"XX")', 'hXXlo'],
    ['=VALUE("12")', 12],
    ['=VALUE(" 3.5 ")', 3.5],
    ['=CHAR(65)', 'A'],
    ['=TRIM("  a   b ")', 'a b'],
    ['=CONCATENATE("a","b",1)', 'ab1'],
  ])('%s = %s', (f, v) => expect(ok(f)).toBe(v))
  it('bad counts and positions are #INVALID VALUE', () => {
    expect(err('=LEFT("a",-1)')).toBe('#INVALID VALUE')
    expect(err('=MID("abc",0,1)')).toBe('#INVALID VALUE')
  })
})

describe('dates', () => {
  const d = (f: string) => ok(f, makeCtx({}, { dest: 'D' }))
  it('DATE rolls over days past the month end', () => {
    expect(d('=DATE(2026,2,30)')).toBe('2026-03-02')
    expect(d('=DATE(2026,1,31)')).toBe('2026-01-31')
    expect(d('=DATE(2026,3,0)')).toBe('2026-02-28')
  })
  it('DAY, MONTH, YEAR, WEEKDAY, YEARDAY', () => {
    expect(ok('=DAY(DATE(2026,3,15))')).toBe(15)
    expect(ok('=MONTH(DATE(2026,3,15))')).toBe(3)
    expect(ok('=YEAR(DATE(2026,3,15))')).toBe(2026)
    expect(ok('=WEEKDAY(DATE(2026,3,15))')).toBe(1) // Sunday
    expect(ok('=WEEKDAY(DATE(2026,3,14))')).toBe(7) // Saturday
    expect(ok('=YEARDAY(DATE(2026,3,15))')).toBe(74)
    expect(ok('=YEARDAY(DATE(2024,12,31))')).toBe(366)
  })
  it('date plus or minus a number is calendar days; date minus date is a number', () => {
    expect(d('=DATE(2026,12,31)+1')).toBe('2027-01-01')
    expect(d('=DATE(2026,3,15)-1')).toBe('2026-03-14')
    expect(ok('=DATE(2026,3,15)-DATE(2026,3,1)')).toBe(14)
    expect(d('=7+DATE(2026,3,1)')).toBe('2026-03-08')
  })
  it('TODAY comes from the context', () => {
    expect(ok('=TODAY()', makeCtx({}, { today: '2026-11-09', dest: 'D' }))).toBe('2026-11-09')
    expect(ok('=TODAY()+7', makeCtx({}, { today: '2026-11-09', dest: 'D' }))).toBe('2026-11-16')
    expect(ok('=TODAY()', makeCtx({}, { dest: 'D' }))).toBe(new Date().toISOString().slice(0, 10))
  })
  it('NETDAYS counts calendar days inclusively; NETWORKDAYS the working days', () => {
    expect(ok('=NETDAYS(DATE(2026,3,1),DATE(2026,3,15))')).toBe(15)
    expect(ok('=NETDAYS(DATE(2026,3,15),DATE(2026,3,1))')).toBe(-15)
    expect(ok('=NETDAYS(DATE(2026,3,1),DATE(2026,3,1))')).toBe(1)
    expect(ok('=NETWORKDAYS(DATE(2026,3,1),DATE(2026,3,15))')).toBe(10)
    expect(ok('=NETWORKDAYS(DATE(2026,3,15),DATE(2026,3,1))')).toBe(-10)
    expect(ok('=NETWORKDAYS(DATE(2026,11,9),DATE(2026,11,13))')).toBe(5)
  })
  it('NETWORKDAYS honours holidays and the sheet calendar', () => {
    const ctx = makeCtx({ Hol: ['2026-11-11'] }, { kinds: { Hol: 'date' } })
    expect(ok('=NETWORKDAYS(DATE(2026,11,9),DATE(2026,11,13),Hol:Hol)', ctx)).toBe(4)
    const sixDay = { ...ctx, calendar: { workingWeekdays: [1, 2, 3, 4, 5, 6], nonWorkingDates: ['2026-11-10'], hoursPerDay: 8 } }
    expect(ok('=NETWORKDAYS(DATE(2026,11,9),DATE(2026,11,14))', sixDay)).toBe(5)
  })
  it('VARIANCE is calendar days from the first to the second date', () => {
    expect(ok('=VARIANCE(DATE(2026,3,1),DATE(2026,3,15))')).toBe(14)
    expect(ok('=VARIANCE(DATE(2026,3,15),DATE(2026,3,1))')).toBe(-14)
  })
  it('WORKDAY moves working days; zero keeps the date even on a weekend', () => {
    expect(d('=WORKDAY(DATE(2026,3,13),1)')).toBe('2026-03-16')
    expect(d('=WORKDAY(DATE(2026,3,13),10)')).toBe('2026-03-27')
    expect(d('=WORKDAY(DATE(2026,3,13),-1)')).toBe('2026-03-12')
    expect(d('=WORKDAY(DATE(2026,3,14),-1)')).toBe('2026-03-13')
    expect(d('=WORKDAY(DATE(2026,3,14),0)')).toBe('2026-03-14')
    expect(d('=WORKDAY(DATE(2026,3,14),1)')).toBe('2026-03-16')
  })
  it('DATEONLY returns the date', () => expect(d('=DATEONLY(DATE(2026,3,1))')).toBe('2026-03-01'))
  it('date functions accept ISO text and return blank for a blank date', () => {
    expect(ok('=DAY("2026-03-15")')).toBe(15)
    const ctx = makeCtx({ Dt: [null] }, { kinds: { Dt: 'date' } })
    expect(ok('=DAY(Dt@row)', ctx)).toBe(null)
    expect(ok('=NETDAYS(Dt@row,Dt@row)', ctx)).toBe(null)
    expect(ok('=Dt@row+1', ctx)).toBe(null)
    expect(err('=DAY("nope")')).toBe('#INVALID DATA TYPE')
    expect(err('=DAY(5)')).toBe('#INVALID DATA TYPE')
  })
})

describe('hierarchy', () => {
  // rows: 0 P1 (1,2,3 = c1 c2 c3), 1 c1, 2 c2, 3 c3, 4 P2 (5,7 = d1 d2), 5 d1 (6 = g1), 6 g1, 7 d2, 8 solo
  const parents = [null, 0, 0, 0, null, 4, 5, 4, null]
  const Num = [undefined, 10, 20, 30, undefined, 5, 7, 8, 99]
  const ctx = (row: number) => makeCtx({ Num, Task: ['P1', 'c1', 'c2', 'c3', 'P2', 'd1', 'g1', 'd2', 'solo'] }, { row, parents, own: 'Num' })

  it('COUNT(ANCESTORS()) is the depth', () => {
    const depth = [0, 1, 1, 1, 0, 1, 2, 1, 0]
    // The own column has numbers only in leaves, so ask a text column that is filled everywhere.
    depth.forEach((want, i) => expect(ok('=COUNT(ANCESTORS(Task@row))', ctx(i))).toBe(want))
  })
  it('CHILDREN covers direct children only; DESCENDANTS all below', () => {
    expect(ok('=SUM(CHILDREN(Num@row))', ctx(0))).toBe(60)
    expect(ok('=SUM(CHILDREN(Num@row))', ctx(4))).toBe(13) // d1 + d2, not g1
    expect(ok('=SUM(DESCENDANTS(Num@row))', ctx(4))).toBe(20)
    expect(ok('=COUNT(CHILDREN(Task@row))', ctx(0))).toBe(3)
    expect(ok('=COUNT(DESCENDANTS(Task@row))', ctx(4))).toBe(3)
    expect(ok('=SUM(CHILDREN(Num@row))', ctx(1))).toBe(0)
    expect(ok('=SUM(CHILDREN(Num@row))+Num@row', ctx(8))).toBe(99)
  })
  it('PARENT is the parent row cell, blank at the top', () => {
    expect(ok('=PARENT(Num@row)', ctx(6))).toBe(5)
    expect(ok('=PARENT(Num@row)', ctx(0))).toBe(null)
    expect(ok('=PARENT(Task@row)', ctx(1))).toBe('P1')
  })
  it('with no argument they use the formula\'s own column', () => {
    expect(ok('=SUM(CHILDREN())', ctx(0))).toBe(60)
    expect(ok('=PARENT()', ctx(6))).toBe(5)
  })
  it('SIBLINGS does not exist', () => expect(err('=COUNT(SIBLINGS())', ctx(0))).toBe('#UNPARSEABLE'))
  it('a hierarchy function needs a cell reference', () => {
    expect(err('=CHILDREN(1)', ctx(0))).toBe('#INVALID REF')
    expect(err('=SUM(CHILDREN())', makeCtx({ Num }, { parents }))).toBe('#INVALID REF') // no own column known
  })
  it('works without a tree (flat sheet): no children, no parent', () => {
    expect(ok('=COUNT(CHILDREN(Num@row))', makeCtx({ Num: [1, 2] }))).toBe(0)
    expect(ok('=COUNT(ANCESTORS(Num@row))', makeCtx({ Num: [1, 2] }))).toBe(0)
  })
})

describe('lists (ours)', () => {
  const ctx = makeCtx({ N: ['b', 'a', 'b', null], X: [1, 2, 3, 4] })
  it('JOIN, HAS, INDEX, MATCH, DISTINCT over a range', () => {
    expect(ok('=JOIN(N:N)', ctx)).toBe('b, a, b')
    expect(ok('=JOIN(N:N,"|")', ctx)).toBe('b|a|b')
    expect(ok('=HAS(N:N,"A")', ctx)).toBe(true)
    expect(ok('=HAS(N:N,"z")', ctx)).toBe(false)
    expect(ok('=INDEX(X:X,3)', ctx)).toBe(3)
    expect(err('=INDEX(X:X,9)', ctx)).toBe('#INVALID VALUE')
    expect(ok('=MATCH(3,X:X)', ctx)).toBe(3)
    expect(ok('=MATCH(9,X:X)', ctx)).toBe(0)
    expect(ok('=COUNT(DISTINCT(N:N))', ctx)).toBe(2)
  })
  it('array literals are #INVALID REF, as observed', () => {
    for (const f of ['=JOIN({1,2,3},",")', '=HAS({1,2},1)', '=INDEX({10,20,30},2)', '=MATCH(20,{10,20,30},0)', '=DISTINCT({1,1,2})']) {
      expect(err(f)).toBe('#INVALID REF')
    }
  })
})

describe('project functions (ours, derived from the scheduling engine)', () => {
  it('CALCDURATION counts working days from start to end, both included', () => {
    expect(ok('=CALCDURATION(DATE(2026,11,9),DATE(2026,11,13))')).toBe(5) // Mon-Fri
    expect(ok('=CALCDURATION(DATE(2026,11,9),DATE(2026,11,16))')).toBe(6) // over a weekend
    expect(ok('=CALCDURATION(DATE(2026,11,9),DATE(2026,11,9))')).toBe(1)
    expect(ok('=CALCDURATION(DATE(2026,11,14),DATE(2026,11,15))')).toBe(0) // a weekend
    expect(err('=CALCDURATION(DATE(2026,11,13),DATE(2026,11,9))')).toBe('#INVALID VALUE')
  })
  it('CALCDURATION uses the sheet calendar and gives blank for blank dates', () => {
    const cal = { workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: ['2026-11-11'], hoursPerDay: 8 }
    expect(ok('=CALCDURATION(DATE(2026,11,9),DATE(2026,11,13))', { ...empty, calendar: cal })).toBe(4)
    const blank = makeCtx({ Dt: [null] }, { kinds: { Dt: 'date' } })
    expect(ok('=CALCDURATION(Dt@row,Dt@row)', blank)).toBe(null)
  })
  it('CALCSTART is the start that gives the duration ending on the end date', () => {
    const d = (f: string, ctx = makeCtx({}, { dest: 'D' })) => ok(f, ctx)
    expect(d('=CALCSTART(5,DATE(2026,11,13))')).toBe('2026-11-09')
    expect(d('=CALCSTART(1,DATE(2026,11,13))')).toBe('2026-11-13')
    expect(d('=CALCSTART(6,DATE(2026,11,16))')).toBe('2026-11-09')
    expect(d('=CALCSTART(0,DATE(2026,11,13))')).toBe('2026-11-13') // a milestone
    expect(d('=CALCSTART(2,DATE(2026,11,15))')).toBe('2026-11-12') // a weekend end counts back from Friday
    // Round trip with CALCDURATION.
    expect(ok('=CALCDURATION(CALCSTART(7,DATE(2026,12,25)),DATE(2026,12,25))')).toBe(7)
  })
  it('CALCSTART reads a duration column', () => {
    const ctx = makeCtx({ Dur: ['3d'] }, { kinds: { Dur: 'duration' }, dest: 'D' })
    expect(ok('=CALCSTART(Dur@row,DATE(2026,11,13))', ctx)).toBe('2026-11-11')
  })
  it('CALCPERCENT is the duration-weighted percent complete of a group', () => {
    const ctx = makeCtx({ Pct: [0, 100, 50, 0], Dur: [0, 2, 2, 4] }, { row: 0, parents: [null, 0, 0, 0], own: 'Pct' })
    expect(ok('=CALCPERCENT(CHILDREN(Pct@row),CHILDREN(Dur@row))', ctx)).toBe(38) // (200 + 100 + 0) / 8 = 37.5
    expect(ok('=CALCPERCENT(CHILDREN(Pct@row),CHILDREN(Pct@row))', ctx)).toBe(83) // (100*100 + 50*50 + 0) / 150
    const noWeight = makeCtx({ Pct: [0, 100, 50], Dur: [0, 0, 0] }, { row: 0, parents: [null, 0, 0] })
    expect(ok('=CALCPERCENT(CHILDREN(Pct@row),CHILDREN(Dur@row))', noWeight)).toBe(75) // plain average when no durations
    expect(ok('=CALCPERCENT(CHILDREN(Pct@row),CHILDREN(Dur@row))', makeCtx({ Pct: [0], Dur: [0] }))).toBe(null) // no children
  })
})

describe('registry', () => {
  it('has an implementation for every listed function and vice versa', () => {
    expect(FUNCTIONS.map((f) => f.name).sort()).toEqual(Object.keys(FUNCS).sort())
  })
  it('lists signatures that start with the name, and finds functions by prefix', () => {
    for (const f of FUNCTIONS) {
      expect(f.signature.startsWith(`${f.name}(`)).toBe(true)
      expect(f.summary.length).toBeGreaterThan(4)
    }
    expect(matchFunctions('cou').map((f) => f.name)).toEqual(['COUNT', 'COUNTIF', 'COUNTIFS'])
    expect(matchFunctions('')).toHaveLength(FUNCTIONS.length)
    expect(matchFunctions('zzz')).toEqual([])
  })
  it('marks our extensions', () => {
    expect(FUNCTIONS.filter((f) => f.ours).map((f) => f.name)).toEqual(
      expect.arrayContaining(['SQRT', 'POWER', 'TRIM', 'CONCATENATE', 'COUNTIFS', 'SUMIFS', 'AVERAGEIFS']),
    )
    expect(FUNCTIONS.find((f) => f.name === 'ROUND')?.ours).toBeUndefined()
  })
  it('every listed function is callable with its minimum number of arguments', () => {
    // Argument counts are enforced by the parser against the registry: calling with min-1 fails.
    for (const f of FUNCTIONS) {
      if (f.min > 0) {
        const call = `=${f.name}(${Array(f.min - 1).fill('1').join(',')})`
        expect(err(call)).toBe('#INCORRECT ARGUMENT SET')
      }
    }
  })
})
