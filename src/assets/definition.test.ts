import { describe, expect, it } from 'vitest'
import {
  defaultChart,
  emptyReportDefinition,
  layoutSources,
  newWidget,
  parseDashboardLayout,
  parseReportDefinition,
  reportProblems,
  safeUrl,
  WIDGET_TYPES,
} from './definition'

describe('parseReportDefinition', () => {
  it('keeps a valid definition unchanged', () => {
    const def = {
      sources: ['a', 'b'],
      columns: [{ key: 'c:task', title: 'Task' }],
      filter: { match: 'any', conditions: [{ column: 'c:task', op: 'contains', value: 'x', value2: '' }] },
      sort: [{ column: 'c:task', dir: 'desc' }],
      groupBy: ['c:task'],
      summaries: [{ column: 'c:cost', fn: 'sum' }],
      gantt: true,
    }
    expect(parseReportDefinition(def)).toEqual(def)
  })

  it('turns anything else into an empty report, and repairs what it can', () => {
    for (const bad of [null, undefined, 3, 'x', [], {}]) expect(parseReportDefinition(bad)).toEqual(emptyReportDefinition())
    const repaired = parseReportDefinition({
      sources: ['a', 'a', 7, '', 'b'],
      columns: [{ key: 'k' }, { key: 'k', title: 'dup' }, 'nope', { title: 'no key' }],
      filter: { match: 'sometimes', conditions: [{ column: 'k', op: 'nonsense' }, { column: 'k', op: 'is' }, 5] },
      sort: [{ column: 'k', dir: 'sideways' }, { dir: 'asc' }],
      groupBy: ['a', 'a', 'b', 'c'],
      summaries: [{ column: 'k', fn: 'median' }, { column: 'k', fn: 'sum' }, { column: 'k', fn: 'avg' }],
      gantt: 'yes',
    })
    expect(repaired.sources).toEqual(['a', 'b'])
    expect(repaired.columns).toEqual([{ key: 'k', title: 'k' }])
    expect(repaired.filter).toEqual({ match: 'all', conditions: [{ column: 'k', op: 'is', value: '', value2: '' }] })
    expect(repaired.sort).toEqual([{ column: 'k', dir: 'asc' }])
    expect(repaired.groupBy).toEqual(['a', 'b'])
    expect(repaired.summaries).toEqual([{ column: 'k', fn: 'sum' }])
    expect(repaired.gantt).toBe(false)
  })

  it('caps the number of sources, columns and conditions', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)
    const def = parseReportDefinition({
      sources: many(30),
      columns: many(80).map((k) => ({ key: k, title: k })),
      filter: { conditions: many(50).map((k) => ({ column: k, op: 'blank' })) },
    })
    expect(def.sources).toHaveLength(10)
    expect(def.columns).toHaveLength(40)
    expect(def.filter.conditions).toHaveLength(20)
  })
})

describe('reportProblems', () => {
  it('needs a source and a column', () => {
    expect(reportProblems(emptyReportDefinition())).toHaveLength(2)
    expect(reportProblems({ ...emptyReportDefinition(), sources: ['a'], columns: [{ key: 'k', title: 'k' }] })).toEqual([])
  })
})

describe('parseDashboardLayout', () => {
  it('round-trips every widget type', () => {
    const widgets = WIDGET_TYPES.map((t, i) => newWidget(t, `w${i}`, 0, i))
    expect(parseDashboardLayout({ widgets })).toEqual({ widgets })
  })

  it('drops unknown widgets, clamps positions and sizes and makes ids unique', () => {
    const layout = parseDashboardLayout({
      widgets: [
        { id: 'a', type: 'text', x: 99, y: -4, w: 50, h: 0, config: { text: 'hi' } },
        { id: 'a', type: 'title', x: 0, y: 0, config: {} },
        { id: 'z', type: 'hologram' },
        'nope',
      ],
    })
    expect(layout.widgets).toHaveLength(2)
    expect(layout.widgets[0]).toMatchObject({ id: 'a', x: 0, y: 0, w: 12, h: 1 })
    expect(layout.widgets[1].id).not.toBe('a')
    expect(parseDashboardLayout(null)).toEqual({ widgets: [] })
    expect(parseDashboardLayout({ widgets: 'x' })).toEqual({ widgets: [] })
  })

  it('repairs widget settings: bad chart kind, out-of-range limit, unsafe URLs', () => {
    const layout = parseDashboardLayout({
      widgets: [
        { id: 'c', type: 'chart', config: { kind: 'radar', limit: 9999, source: { type: 'folder', id: 'x' } } },
        { id: 'i', type: 'image', config: { url: 'javascript:alert(1)', link: 'https://example.com/a' } },
        { id: 's', type: 'shortcut', config: { links: [{ kind: 'url', target: 'data:text/html,hi' }, { kind: 'report', target: 'r1', label: 'R' }, { kind: 'sheet' }] } },
      ],
    })
    const [chart, image, shortcut] = layout.widgets
    expect(chart.config).toMatchObject({ kind: 'column', limit: 50, source: null })
    expect(image.config).toEqual({ url: '', alt: '', link: 'https://example.com/a' })
    expect(shortcut.config).toEqual({ links: [{ kind: 'report', target: 'r1', label: 'R' }] })
  })

  it('limits the number of widgets', () => {
    const widgets = Array.from({ length: 100 }, (_, i) => ({ id: `w${i}`, type: 'text', config: {} }))
    expect(parseDashboardLayout({ widgets }).widgets).toHaveLength(60)
  })
})

describe('safeUrl', () => {
  it('allows http(s) only', () => {
    expect(safeUrl('https://example.com/x?y=1')).toBe('https://example.com/x?y=1')
    expect(safeUrl('  http://example.com ')).toBe('http://example.com/')
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//example.com', 'example.com', '', 5]) expect(safeUrl(bad)).toBe('')
  })
})

describe('layoutSources', () => {
  it('lists each source once', () => {
    const a = newWidget('chart', 'a')
    const b = newWidget('metric', 'b')
    const c = newWidget('chart', 'c')
    if (a.type === 'chart') a.config = { ...defaultChart(), source: { type: 'sheet', id: 'S1' } }
    if (b.type === 'metric') b.config.source = { type: 'sheet', id: 'S1' }
    if (c.type === 'chart') c.config.source = { type: 'report', id: 'R1' }
    expect(layoutSources({ widgets: [a, b, c, newWidget('text', 'd')] })).toEqual([
      { type: 'sheet', id: 'S1' },
      { type: 'report', id: 'R1' },
    ])
  })
})
