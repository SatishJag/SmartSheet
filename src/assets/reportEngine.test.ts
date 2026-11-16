import { describe, expect, it } from 'vitest'
import {
  availableColumns,
  colKey,
  evaluateReport,
  pickTimeColumns,
  reportToCsv,
  resolveWriteBack,
  ROW_KEY,
  SHEET_KEY,
  summarize,
} from './reportEngine'
import { reportDef, sheetFromTable } from './testSupport'
import type { Condition, ReportDefinition } from './types'

const TODAY = '2026-11-16'
const cond = (column: string, op: Condition['op'], value = '', value2 = ''): Condition => ({ column: colKey(column), op, value, value2 })
const cols = (...titles: string[]) => titles.map((t) => ({ key: colKey(t), title: t }))

const site = sheetFromTable(
  'A',
  'Site works',
  [['Task'], ['Status', 'PICKLIST', ['Open', 'Done']], ['Due', 'DATE'], ['Cost'], ['Urgent', 'CHECKBOX']],
  [
    ['Dig trench', 'Open', '2026-11-10', 1200, true],
    ['Pour slab', 'Done', '2026-11-20', 3400, false],
    ['Frame walls', 'Open', '2026-12-01', 800, false],
    [null, null, null, null, null], // an empty row: reports skip it
  ],
)
const fit = sheetFromTable(
  'B',
  'Fit-out',
  [['task'], ['Status ', 'PICKLIST', ['Open', 'Blocked']], ['Owner'], ['Cost']],
  [
    ['Hang doors', 'Blocked', 'Ana', 300],
    ['Paint', 'Open', 'Bo', 450],
  ],
)

function run(patch: Partial<ReportDefinition>, sheets = [site, fit]) {
  return evaluateReport(reportDef({ sources: sheets.map((s) => s.id), columns: cols('Task', 'Status', 'Cost'), ...patch }), sheets, { today: TODAY })
}
const tasks = (r: ReturnType<typeof run>) => r.rows.map((row) => row.values[colKey('Task')])

describe('availableColumns', () => {
  it('lists Sheet and Row first, then each title once, matched case-insensitively', () => {
    const list = availableColumns([site, fit])
    expect(list.map((c) => c.title)).toEqual(['Sheet', 'Row', 'Task', 'Status', 'Due', 'Cost', 'Urgent', 'Owner'])
    const status = list.find((c) => c.key === colKey('status'))!
    expect(status.sheetCount).toBe(2)
    expect(status.options).toEqual(['Open', 'Done', 'Blocked'])
    expect(list.find((c) => c.title === 'Owner')!.sheetCount).toBe(1)
  })

  it('falls back to text when sheets disagree on a column type', () => {
    const a = sheetFromTable('a', 'a', [['When', 'DATE']], [['2026-01-01']])
    const b = sheetFromTable('b', 'b', [['When']], [['soon']])
    expect(availableColumns([a, b]).find((c) => c.title === 'When')!.type).toBe('TEXT_NUMBER')
  })
})

describe('evaluateReport', () => {
  it('pulls rows from every source, maps columns by title and leaves a blank where a sheet lacks one', () => {
    const r = run({ columns: cols('Task', 'Owner', 'Cost') })
    expect(r.scanned).toBe(5) // the empty row is skipped
    expect(r.matched).toBe(5)
    expect(tasks(r)).toEqual(['Dig trench', 'Pour slab', 'Frame walls', 'Hang doors', 'Paint'])
    expect(r.rows.map((x) => x.values[colKey('Owner')])).toEqual([null, null, null, 'Ana', 'Bo'])
    expect(r.rows[3]).toMatchObject({ sheetId: 'B', sheetName: 'Fit-out', rowId: 'r1', rowNumber: 1, id: 'B:r1' })
  })

  it('offers the Sheet and Row columns', () => {
    const r = run({ columns: [{ key: SHEET_KEY, title: 'Sheet' }, { key: ROW_KEY, title: 'Row' }, ...cols('Task')] })
    expect(r.rows[1].values[SHEET_KEY]).toBe('Site works')
    expect(r.rows[1].values[ROW_KEY]).toBe(2)
  })

  it('reports a source that is gone and a column nothing has, without failing', () => {
    const r = run({ sources: ['A', 'gone'], columns: cols('Task', 'Nope') })
    expect(r.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/no longer available/), expect.stringMatching(/"Nope"/)]))
    expect(r.matched).toBe(3)
  })

  describe('filters', () => {
    it('combines conditions with AND or OR', () => {
      const both = run({ filter: { match: 'all', conditions: [cond('Status', 'is', 'Open'), cond('Cost', 'gt', '500')] } })
      expect(tasks(both)).toEqual(['Dig trench', 'Frame walls'])
      const either = run({ filter: { match: 'any', conditions: [cond('Status', 'is', 'Blocked'), cond('Cost', 'gt', '3000')] } })
      expect(tasks(either)).toEqual(['Pour slab', 'Hang doors'])
    })

    it('equals ignores case and spaces; contains matches parts; not-variants negate', () => {
      expect(tasks(run({ filter: { match: 'all', conditions: [cond('Task', 'is', '  PAINT ')] } }))).toEqual(['Paint'])
      expect(tasks(run({ filter: { match: 'all', conditions: [cond('Task', 'contains', 'ra')] } }))).toEqual(['Frame walls'])
      expect(tasks(run({ filter: { match: 'all', conditions: [cond('Status', 'isNot', 'Open')] } }))).toEqual(['Pour slab', 'Hang doors'])
      expect(tasks(run({ filter: { match: 'all', conditions: [cond('Task', 'notContains', 'a')] } }))).toEqual(['Dig trench'])
    })

    it('compares numbers numerically, not as text', () => {
      const r = run({ filter: { match: 'all', conditions: [cond('Cost', 'lte', '450'), cond('Cost', 'gte', '300')] } })
      expect(tasks(r)).toEqual(['Hang doors', 'Paint'])
      expect(tasks(run({ filter: { match: 'all', conditions: [cond('Cost', 'between', '400', '1000')] } }))).toEqual(['Frame walls', 'Paint'])
    })

    it('tests for blank values, including a column a sheet does not have', () => {
      expect(tasks(run({ filter: { match: 'all', conditions: [cond('Owner', 'notBlank')] } }))).toEqual(['Hang doors', 'Paint'])
      expect(tasks(run({ filter: { match: 'all', conditions: [cond('Owner', 'blank')] } }))).toEqual(['Dig trench', 'Pour slab', 'Frame walls'])
    })

    it('handles dates: before / after a day, "today" tokens, ranges, the last and next days', () => {
      const due = (c: Condition) => tasks(run({ columns: cols('Task', 'Due'), filter: { match: 'all', conditions: [c] } }))
      expect(due(cond('Due', 'lt', 'today'))).toEqual(['Dig trench'])
      expect(due(cond('Due', 'gte', 'today+4'))).toEqual(['Pour slab', 'Frame walls'])
      expect(due(cond('Due', 'between', 'today', 'today+7'))).toEqual(['Pour slab'])
      expect(due(cond('Due', 'is', '2026-12-01'))).toEqual(['Frame walls'])
      expect(due(cond('Due', 'lastDays', '7'))).toEqual(['Dig trench'])
      expect(due(cond('Due', 'nextDays', '30'))).toEqual(['Pour slab', 'Frame walls'])
      expect(due(cond('Due', 'blank'))).toEqual(['Hang doors', 'Paint']) // the other sheet has no Due column
    })

    it('handles checkboxes and picklist lists', () => {
      expect(tasks(run({ filter: { match: 'all', conditions: [cond('Urgent', 'is', 'true')] } }))).toEqual(['Dig trench'])
      expect(tasks(run({ filter: { match: 'all', conditions: [cond('Urgent', 'is', 'false')] } }))).toEqual(['Pour slab', 'Frame walls', 'Hang doors', 'Paint'])
      const tags = sheetFromTable('T', 'Tags', [['Task'], ['Tags', 'MULTI_PICKLIST', ['a', 'b']]], [['x', ['a', 'b']], ['y', ['b']]])
      const r = evaluateReport(
        reportDef({ sources: ['T'], columns: cols('Task'), filter: { match: 'all', conditions: [cond('Tags', 'is', 'a')] } }),
        [tags],
        { today: TODAY },
      )
      expect(r.rows.map((x) => x.values[colKey('Task')])).toEqual(['x'])
    })

    it('ignores unfinished conditions (a blank value) instead of hiding everything', () => {
      expect(run({ filter: { match: 'all', conditions: [cond('Cost', 'gt', '')] } }).matched).toBe(5)
    })
  })

  describe('sort', () => {
    it('sorts by several columns, numbers as numbers, with blanks last in both directions', () => {
      const asc = run({ sort: [{ column: colKey('Cost'), dir: 'asc' }] })
      expect(tasks(asc)).toEqual(['Hang doors', 'Paint', 'Frame walls', 'Dig trench', 'Pour slab'])
      const desc = run({ sort: [{ column: colKey('Cost'), dir: 'desc' }] })
      expect(tasks(desc)).toEqual(['Pour slab', 'Dig trench', 'Frame walls', 'Paint', 'Hang doors'])
      const due = run({ sort: [{ column: colKey('Due'), dir: 'desc' }] })
      expect(tasks(due).slice(0, 3)).toEqual(['Frame walls', 'Pour slab', 'Dig trench'])
      expect(tasks(due).slice(3)).toEqual(['Hang doors', 'Paint']) // no Due: last, in source order
      const multi = run({ sort: [{ column: colKey('Status'), dir: 'asc' }, { column: colKey('Cost'), dir: 'desc' }] })
      expect(tasks(multi)).toEqual(['Hang doors', 'Pour slab', 'Dig trench', 'Frame walls', 'Paint'])
    })
  })

  describe('grouping', () => {
    it('groups by one column with a count and summaries per group, and totals', () => {
      const r = run({
        groupBy: [colKey('Status')],
        summaries: [{ column: colKey('Cost'), fn: 'sum' }, { column: colKey('Task'), fn: 'count' }],
      })
      expect(r.groups!.map((g) => [g.label, g.count, g.summaries[colKey('Cost')], g.summaries[colKey('Task')]])).toEqual([
        ['Blocked', 1, 300, 1],
        ['Done', 1, 3400, 1],
        ['Open', 3, 2450, 3],
      ])
      expect(r.totals[colKey('Cost')]).toBe(6150)
      expect(r.totals[colKey('Task')]).toBe(5)
      // rows come back in group order, so a flat view matches the grouped one
      expect(tasks(r)).toEqual(['Hang doors', 'Pour slab', 'Dig trench', 'Frame walls', 'Paint'])
    })

    it('supports two levels, a (Blank) bucket and descending group order', () => {
      const r = run({ groupBy: [colKey('Owner'), colKey('Status')], sort: [{ column: colKey('Owner'), dir: 'desc' }] })
      expect(r.groups!.map((g) => g.label)).toEqual(['Bo', 'Ana', '(Blank)'])
      const blank = r.groups!.find((g) => g.label === '(Blank)')!
      expect(blank.count).toBe(3)
      expect(blank.groups!.map((g) => [g.label, g.count])).toEqual([['Done', 1], ['Open', 2]])
      expect(blank.groups![1].rows!.map((x) => x.values[colKey('Task')])).toEqual(['Dig trench', 'Frame walls'])
    })
  })

  it('has no groups unless asked', () => {
    expect(run({}).groups).toBeNull()
  })

  it('scales to 10 sources of 5,000 rows', () => {
    const big = Array.from({ length: 10 }, (_, s) =>
      sheetFromTable(
        `S${s}`,
        `Sheet ${s}`,
        [['Task'], ['Status', 'PICKLIST', ['Open', 'Done']], ['Cost'], ['Due', 'DATE']],
        Array.from({ length: 5000 }, (_, i) => [`Task ${i}`, i % 3 === 0 ? 'Done' : 'Open', (i * 7) % 1000, `2026-${String((i % 12) + 1).padStart(2, '0')}-15`]),
      ),
    )
    const started = performance.now()
    const r = evaluateReport(
      reportDef({
        sources: big.map((s) => s.id),
        columns: cols('Task', 'Status', 'Cost', 'Due'),
        filter: { match: 'all', conditions: [cond('Status', 'is', 'Open'), cond('Cost', 'gt', '100')] },
        sort: [{ column: colKey('Cost'), dir: 'desc' }, { column: colKey('Task'), dir: 'asc' }],
        groupBy: [colKey('Status')],
        summaries: [{ column: colKey('Cost'), fn: 'sum' }],
      }),
      big,
      { today: TODAY },
    )
    const ms = performance.now() - started
    expect(r.scanned).toBe(50_000)
    expect(r.matched).toBeGreaterThan(20_000)
    expect(r.groups).toHaveLength(1)
    expect(ms).toBeLessThan(5000)
  })
})

describe('summarize', () => {
  it('count counts non-blank values (a checked box counts, an unchecked one does not)', () => {
    expect(summarize([1, null, '', 0, 'a'], 'count')).toBe(3)
    expect(summarize([true, false, true], 'count', 'CHECKBOX')).toBe(2)
  })
  it('sum and avg use numbers, including numeric text, and are null with none', () => {
    expect(summarize([1, 2.5, '4', 'x', null], 'sum')).toBe(7.5)
    expect(summarize([1, 2], 'avg')).toBe(1.5)
    expect(summarize(['a'], 'sum')).toBeNull()
    expect(summarize([0.1, 0.2], 'sum')).toBe(0.3)
  })
  it('min and max order numbers, dates and text', () => {
    expect(summarize([5, 2, 9, null], 'min')).toBe(2)
    expect(summarize([5, 2, 9], 'max')).toBe(9)
    expect(summarize(['2026-03-01', '2026-01-09'], 'min', 'DATE')).toBe('2026-01-09')
    expect(summarize(['b', 'a'], 'max')).toBe('b')
    expect(summarize([null], 'max')).toBeNull()
  })
})

describe('resolveWriteBack', () => {
  const locked = sheetFromTable('L', 'Locked', [['Task'], ['Start', 'DATE']], [['x', '2026-01-01']], {
    readOnly: (_row, col) => (col === 'L-c1' ? 'Start date is set by predecessors' : null),
  })
  const sheets = new Map([site, fit, locked].map((s) => [s.id, s]))
  const result = evaluateReport(reportDef({ sources: ['A', 'B', 'L'], columns: cols('Task', 'Cost', 'Start') }), [site, fit, locked], { today: TODAY })

  it('maps a report cell to the source sheet, row and column', () => {
    const row = result.rows.find((r) => r.sheetId === 'B' && r.rowId === 'r2')!
    expect(resolveWriteBack(result, sheets, row, colKey('Cost'))).toEqual({ ok: true, sheetId: 'B', rowId: 'r2', colId: 'B-c3' })
    expect(resolveWriteBack(result, sheets, row, colKey('Task'))).toEqual({ ok: true, sheetId: 'B', rowId: 'r2', colId: 'B-c0' })
  })

  it('refuses the built-in columns, a sheet without the column, and a read-only source cell', () => {
    const inA = result.rows.find((r) => r.sheetId === 'A')!
    expect(resolveWriteBack(result, sheets, inA, SHEET_KEY)).toMatchObject({ ok: false })
    expect(resolveWriteBack(result, sheets, inA, colKey('Start'))).toMatchObject({ ok: false, reason: expect.stringMatching(/no column/) })
    const inL = result.rows.find((r) => r.sheetId === 'L')!
    expect(resolveWriteBack(result, sheets, inL, colKey('Start'))).toEqual({ ok: false, reason: 'Start date is set by predecessors' })
  })
})

describe('reportToCsv', () => {
  it('writes displayed columns, quotes where needed and neutralises formulas', () => {
    const s = sheetFromTable('C', 'C', [['Task'], ['Note'], ['Done', 'CHECKBOX']], [['a, b', '=1+1', true], ['say "hi"', 'plain', false]])
    const r = evaluateReport(reportDef({ sources: ['C'], columns: cols('Task', 'Note', 'Done') }), [s], { today: TODAY })
    expect(reportToCsv(r)).toBe('Task,Note,Done\r\n"a, b",\'=1+1,Yes\r\n"say ""hi""",plain,No')
  })
})

describe('pickTimeColumns', () => {
  it('finds start, end and label columns', () => {
    const picked = pickTimeColumns(availableColumns([sheetFromTable('P', 'P', [['Task'], ['Finish', 'DATE'], ['Start', 'DATE']], [])]))
    expect(picked).toEqual({ label: colKey('Task'), start: colKey('Start'), end: colKey('Finish') })
  })
})
