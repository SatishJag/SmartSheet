import { describe, expect, it } from 'vitest'
import { defaultChart, defaultMetric, defaultTime } from './definition'
import { colKey, evaluateReport } from './reportEngine'
import { reportDef, sheetFromTable } from './testSupport'
import type { Condition } from './types'
import { chartData, formatMetric, metricValue, tableFromReport, tableFromSheet, timeItems } from './widgetData'

const TODAY = '2026-11-16'
const sheet = sheetFromTable(
  'S',
  'Tasks',
  [['Task'], ['Status', 'PICKLIST', ['Open', 'Doing', 'Done']], ['Trade'], ['Cost'], ['Start', 'DATE'], ['End', 'DATE']],
  [
    ['A', 'Done', 'Civil', 100, '2026-10-01', '2026-10-10'],
    ['B', 'Doing', 'Civil', 250, '2026-11-02', '2026-11-20'],
    ['C', 'Open', 'MEP', 50, '2026-11-25', null],
    ['D', 'Open', 'MEP', 400, '2026-12-15', '2026-12-31'],
    ['E', 'Done', 'Fit-out', 75, null, null],
  ],
)
const table = tableFromSheet(sheet)
const col = (title: string) => sheet.columns.find((c) => c.title === title)!.id
const cond = (title: string, op: Condition['op'], value = ''): Condition => ({ column: col(title), op, value, value2: '' })

describe('metricValue', () => {
  it('counts rows, with and without a filter', () => {
    expect(metricValue(table, defaultMetric(), TODAY).value).toBe(5)
    const open = { ...defaultMetric(), filter: { match: 'all' as const, conditions: [cond('Status', 'is', 'Open')] } }
    expect(metricValue(table, open, TODAY).value).toBe(2)
  })

  it('sums, averages and takes min / max of a column', () => {
    const m = (fn: 'sum' | 'avg' | 'min' | 'max') => metricValue(table, { ...defaultMetric(), fn, column: col('Cost') }, TODAY).value
    expect([m('sum'), m('avg'), m('min'), m('max')]).toEqual([875, 175, 50, 400])
    expect(metricValue(table, { ...defaultMetric(), fn: 'min', column: col('Start') }, TODAY).value).toBe('2026-10-01')
  })

  it('percent is the share of rows matching the filter', () => {
    const done = { ...defaultMetric(), fn: 'percent' as const, filter: { match: 'all' as const, conditions: [cond('Status', 'is', 'Done')] } }
    expect(metricValue(table, done, TODAY).value).toBe(40)
  })

  it('reads one cell', () => {
    expect(metricValue(table, { ...defaultMetric(), mode: 'cell', column: col('Cost'), rowId: 'r2' }, TODAY).value).toBe(250)
    expect(metricValue(table, { ...defaultMetric(), mode: 'cell', column: col('Status'), rowId: 'r1' }, TODAY).value).toBe('Done')
    expect(metricValue(table, { ...defaultMetric(), mode: 'cell', column: col('Cost'), rowId: 'nope' }, TODAY).note).toMatch(/no longer exists/)
  })

  it('says what is missing instead of failing', () => {
    expect(metricValue(table, { ...defaultMetric(), fn: 'sum' }, TODAY)).toMatchObject({ value: null, note: 'Choose a column.' })
    expect(metricValue(table, { ...defaultMetric(), fn: 'sum', column: 'gone' }, TODAY).note).toMatch(/no longer exists/)
  })

  it('formats with prefix, suffix, separators and a percent sign', () => {
    expect(formatMetric(1234.5, { format: 'auto', prefix: '$', suffix: '' })).toMatch(/^\$1.234[.,]5$/)
    expect(formatMetric(40, { format: 'percent', prefix: '', suffix: '' })).toBe('40%')
    expect(formatMetric(3, { format: 'auto', prefix: '', suffix: ' days' })).toBe('3 days')
    expect(formatMetric(null, { format: 'auto', prefix: '$', suffix: '' })).toBe('–')
  })

  it('works on a report as well as on a sheet', () => {
    const other = sheetFromTable('O', 'Other', [['Task'], ['Cost']], [['X', 1000]])
    const result = evaluateReport(
      reportDef({ sources: ['S', 'O'], columns: [{ key: colKey('Task'), title: 'Task' }, { key: colKey('Cost'), title: 'Cost' }] }),
      [sheet, other],
      { today: TODAY },
    )
    const t = tableFromReport(result)
    expect(metricValue(t, { ...defaultMetric(), fn: 'sum', column: colKey('Cost') }, TODAY).value).toBe(1875)
  })
})

describe('chartData', () => {
  const chart = (patch: Partial<ReturnType<typeof defaultChart>>) => chartData(table, { ...defaultChart(), category: col('Status'), ...patch }, TODAY)

  it('counts rows per category, in picklist order', () => {
    const d = chart({})
    expect(d.categories).toEqual(['Open', 'Doing', 'Done'])
    expect(d.series).toEqual([{ name: 'Count', values: [2, 1, 2] }])
  })

  it('sums a value column, biggest first when asked', () => {
    const d = chart({ category: col('Trade'), value: col('Cost'), fn: 'sum', order: 'value' })
    expect(d.categories).toEqual(['MEP', 'Civil', 'Fit-out'])
    expect(d.series).toEqual([{ name: 'Sum of Cost', values: [450, 350, 75] }])
  })

  it('limits the categories to the largest and says so', () => {
    const d = chart({ category: col('Task'), limit: 2, value: col('Cost'), fn: 'sum' })
    expect(d.note).toMatch(/2 largest of 5/)
    expect(d.categories).toEqual(['B', 'D']) // the two largest, back in natural order
  })

  it('stacks by another column', () => {
    const d = chart({ kind: 'stacked', category: col('Trade'), stackBy: col('Status') })
    expect(d.categories).toEqual(['Civil', 'Fit-out', 'MEP'])
    const byName = Object.fromEntries(d.series.map((s) => [s.name, s.values]))
    expect(byName).toEqual({ Done: [1, 1, 0], Open: [0, 0, 2], Doing: [1, 0, 0] })
  })

  it('groups dates into months and puts blanks last', () => {
    const d = chart({ category: col('Start') })
    expect(d.categories).toEqual(['2026-10', '2026-11', '2026-12', '(Blank)'])
    expect(d.series[0].values).toEqual([1, 2, 1, 1])
  })

  it('applies the widget filter', () => {
    const d = chart({ filter: { match: 'all', conditions: [cond('Trade', 'is', 'MEP')] } })
    expect(d.series[0].values.reduce((a, b) => a + b, 0)).toBe(2)
  })

  it('is empty without a category', () => {
    expect(chartData(table, defaultChart(), TODAY)).toEqual({ categories: [], series: [] })
  })
})

describe('timeItems', () => {
  const cfg = { ...defaultTime(), label: col('Task'), start: col('Start'), end: col('End') }

  it('lists items by start date, treats a missing end as a milestone and skips rows with no start', () => {
    const d = timeItems(table, cfg, TODAY)
    expect(d.items.map((i) => [i.label, i.start, i.end, i.milestone])).toEqual([
      ['A', '2026-10-01', '2026-10-10', false],
      ['B', '2026-11-02', '2026-11-20', false],
      ['C', '2026-11-25', '2026-11-25', true],
      ['D', '2026-12-15', '2026-12-31', false],
    ])
    expect(d.skipped).toBe(1)
    expect([d.min, d.max]).toEqual(['2026-10-01', '2026-12-31'])
  })

  it('honours the filter and the limit', () => {
    const d = timeItems(table, { ...cfg, limit: 1, filter: { match: 'all', conditions: [cond('Status', 'is', 'Open')] } }, TODAY)
    expect(d.items.map((i) => i.label)).toEqual(['C'])
    expect(d.note).toMatch(/first 1 of 2/)
  })

  it('is empty without a start column', () => {
    expect(timeItems(table, defaultTime(), TODAY).items).toEqual([])
  })
})
