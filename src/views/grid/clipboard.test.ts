import { describe, expect, it } from 'vitest'
import {
  describeRejections,
  parseTsv,
  planPaste,
  rangeCells,
  rangeContains,
  rangeFrom,
  rangeHeight,
  rangeSize,
  rangeWidth,
  serializeTsv,
} from './clipboard'

describe('range math', () => {
  it('normalises corners given in any order', () => {
    const expected = { top: 1, left: 2, bottom: 4, right: 5 }
    expect(rangeFrom({ row: 1, col: 2 }, { row: 4, col: 5 })).toEqual(expected)
    expect(rangeFrom({ row: 4, col: 5 }, { row: 1, col: 2 })).toEqual(expected)
    expect(rangeFrom({ row: 4, col: 2 }, { row: 1, col: 5 })).toEqual(expected)
    expect(rangeFrom({ row: 1, col: 5 }, { row: 4, col: 2 })).toEqual(expected)
  })

  it('a single cell is a 1x1 range', () => {
    const r = rangeFrom({ row: 3, col: 3 }, { row: 3, col: 3 })
    expect([rangeHeight(r), rangeWidth(r), rangeSize(r)]).toEqual([1, 1, 1])
    expect(rangeCells(r)).toEqual([{ row: 3, col: 3 }])
  })

  it('contains its edges and nothing outside', () => {
    const r = { top: 1, left: 1, bottom: 2, right: 3 }
    expect(rangeContains(r, 1, 1)).toBe(true)
    expect(rangeContains(r, 2, 3)).toBe(true)
    expect(rangeContains(r, 0, 1)).toBe(false)
    expect(rangeContains(r, 3, 1)).toBe(false)
    expect(rangeContains(r, 1, 0)).toBe(false)
    expect(rangeContains(r, 1, 4)).toBe(false)
  })

  it('lists cells row by row, left to right', () => {
    expect(rangeCells({ top: 0, left: 1, bottom: 1, right: 2 })).toEqual([
      { row: 0, col: 1 },
      { row: 0, col: 2 },
      { row: 1, col: 1 },
      { row: 1, col: 2 },
    ])
    expect(rangeSize({ top: 0, left: 1, bottom: 1, right: 2 })).toBe(4)
  })
})

describe('parseTsv', () => {
  it('splits rows and tabs', () => {
    expect(parseTsv('a\tb\nc\td')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('handles CRLF and lone CR line breaks', () => {
    expect(parseTsv('a\tb\r\nc\td')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(parseTsv('a\rb')).toEqual([['a'], ['b']])
  })

  it('drops one trailing line break, as spreadsheet apps add', () => {
    expect(parseTsv('a\tb\r\n')).toEqual([['a', 'b']])
    expect(parseTsv('a\n')).toEqual([['a']])
    // A second line break is a real (blank) row.
    expect(parseTsv('a\n\n')).toEqual([['a'], ['']])
  })

  it('keeps empty fields, including leading and trailing ones', () => {
    expect(parseTsv('\ta\t')).toEqual([['', 'a', '']])
    expect(parseTsv('a\t\tb')).toEqual([['a', '', 'b']])
  })

  it('reads empty text as one empty cell', () => {
    expect(parseTsv('')).toEqual([['']])
    expect(parseTsv('\r\n')).toEqual([['']])
  })

  it('reads quoted fields with embedded tabs, line breaks and doubled quotes', () => {
    expect(parseTsv('"a\tb"\tc')).toEqual([['a\tb', 'c']])
    expect(parseTsv('"line 1\nline 2"\tx\r\ny\tz')).toEqual([
      ['line 1\nline 2', 'x'],
      ['y', 'z'],
    ])
    expect(parseTsv('"line 1\r\nline 2"')).toEqual([['line 1\r\nline 2']])
    expect(parseTsv('"say ""hi"""\tb')).toEqual([['say "hi"', 'b']])
    expect(parseTsv('""\tb')).toEqual([['', 'b']])
  })

  it('treats quotes that do not wrap a whole field as literal text', () => {
    expect(parseTsv('5" pipe\tb')).toEqual([['5" pipe', 'b']])
    expect(parseTsv('"12" bolt\tb')).toEqual([['"12" bolt', 'b']])
    expect(parseTsv('"unterminated\tb')).toEqual([['"unterminated', 'b']])
  })

  it('reads ragged rows as they are', () => {
    expect(parseTsv('a\tb\tc\nd')).toEqual([['a', 'b', 'c'], ['d']])
  })
})

describe('serializeTsv', () => {
  it('joins with tabs and line feeds, without a trailing line break', () => {
    expect(
      serializeTsv([
        ['a', 'b'],
        ['c', ''],
      ]),
    ).toBe('a\tb\nc\t')
  })

  it('quotes only fields that need it', () => {
    expect(serializeTsv([['a\tb', 'x\ny', '5" pipe', '"quoted', 'plain']])).toBe(
      '"a\tb"\t"x\ny"\t5" pipe\t"""quoted"\tplain',
    )
  })

  it('round-trips through parseTsv', () => {
    const cells = [
      ['Task 1', '=SUM(1, 2)', 'tab\there', ''],
      ['multi\r\nline', '"quote" first', 'inner " quote', '50%'],
    ]
    expect(parseTsv(serializeTsv(cells))).toEqual(cells)
  })
})

describe('planPaste', () => {
  const at = (row: number, col: number) => ({ top: row, left: col, bottom: row, right: col })

  it('places a block from the top-left of the selection', () => {
    const plan = planPaste(
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
      at(1, 2),
      10,
      10,
    )
    expect(plan.cells).toEqual([
      { row: 1, col: 2, value: 'a' },
      { row: 1, col: 3, value: 'b' },
      { row: 2, col: 2, value: 'c' },
      { row: 2, col: 3, value: 'd' },
    ])
    expect(plan.range).toEqual({ top: 1, left: 2, bottom: 2, right: 3 })
    expect(plan.clipped).toBe(0)
  })

  it('fills a multi-cell selection with a single value', () => {
    const plan = planPaste([['x']], { top: 0, left: 0, bottom: 1, right: 2 }, 10, 10)
    expect(plan.cells).toHaveLength(6)
    expect(plan.cells.every((c) => c.value === 'x')).toBe(true)
    expect(plan.range).toEqual({ top: 0, left: 0, bottom: 1, right: 2 })
  })

  it('repeats a block over a selection that is a whole multiple of it', () => {
    const plan = planPaste([['a', 'b']], { top: 0, left: 0, bottom: 1, right: 3 }, 10, 10)
    expect(plan.cells.map((c) => c.value)).toEqual(['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b'])
  })

  it('pastes the block once when the selection is not a multiple of it', () => {
    const plan = planPaste([['a', 'b']], { top: 0, left: 0, bottom: 0, right: 2 }, 10, 10)
    expect(plan.cells.map((c) => c.value)).toEqual(['a', 'b'])
  })

  it('pastes a block larger than the selection in full', () => {
    const plan = planPaste([['a', 'b', 'c']], { top: 0, left: 0, bottom: 0, right: 1 }, 10, 10)
    expect(plan.cells.map((c) => c.value)).toEqual(['a', 'b', 'c'])
  })

  it('drops values past the last row or column and counts them', () => {
    const plan = planPaste(
      [
        ['a', 'b'],
        ['c', 'd'],
        ['e', 'f'],
      ],
      at(8, 3),
      10,
      5,
    )
    expect(plan.cells).toEqual([
      { row: 8, col: 3, value: 'a' },
      { row: 8, col: 4, value: 'b' },
      { row: 9, col: 3, value: 'c' },
      { row: 9, col: 4, value: 'd' },
    ])
    expect(plan.clipped).toBe(2)
    expect(plan.range).toEqual({ top: 8, left: 3, bottom: 9, right: 4 })
  })

  it('pads ragged rows with empty values', () => {
    const plan = planPaste([['a', 'b'], ['c']], at(0, 0), 10, 10)
    expect(plan.cells.map((c) => c.value)).toEqual(['a', 'b', 'c', ''])
  })
})

describe('describeRejections', () => {
  it('is null when nothing was rejected', () => {
    expect(describeRejections([])).toBeNull()
  })

  it('summarises one rejection', () => {
    expect(describeRejections([{ where: 'row 3 Status', reason: 'Choose one of: A, B' }])).toBe(
      '1 cell was not pasted: row 3 Status (Choose one of: A, B)',
    )
  })

  it('lists at most three and counts the rest, plus clipped values', () => {
    const rejected = [1, 2, 3, 4, 5].map((n) => ({ where: `row ${n} End`, reason: 'read-only' }))
    expect(describeRejections(rejected, 2)).toBe(
      '7 cells were not pasted: row 1 End (read-only); row 2 End (read-only); row 3 End (read-only); and 2 more; 2 past the end of the sheet',
    )
  })

  it('uses the given verb', () => {
    expect(describeRejections([{ where: 'row 1 End', reason: 'read-only' }], 0, 'cleared')).toBe(
      '1 cell was not cleared: row 1 End (read-only)',
    )
  })
})
