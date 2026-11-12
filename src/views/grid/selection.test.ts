import { describe, expect, it } from 'vitest'
import { inBounds, mapPaste, parseTsv, rangeBounds, toTsv } from './selection'

describe('range math', () => {
  it('orders the corners and tests membership', () => {
    const b = rangeBounds({ r: 4, c: 1 }, { r: 2, c: 3 })
    expect(b).toEqual({ r0: 2, r1: 4, c0: 1, c1: 3 })
    expect(inBounds(b, 3, 2)).toBe(true)
    expect(inBounds(b, 5, 2)).toBe(false)
    expect(inBounds(b, 3, 0)).toBe(false)
  })
})

describe('TSV', () => {
  it('serializes rows by newline and quotes awkward fields', () => {
    expect(toTsv([['a', 'b'], ['c', '']])).toBe('a\tb\nc\t')
    expect(toTsv([['say "hi"', 'x\ny', 'p\tq']])).toBe('"say ""hi"""\t"x\ny"\t"p\tq"')
  })

  it('parses plain text, CRLF and a trailing newline', () => {
    expect(parseTsv('a\tb\r\nc\td\r\n')).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseTsv('one')).toEqual([['one']])
    expect(parseTsv('a\t\tc\n\nz')).toEqual([['a', '', 'c'], [''], ['z']])
    expect(parseTsv('')).toEqual([])
  })

  it('parses Excel-style quoted fields and round-trips toTsv', () => {
    expect(parseTsv('"say ""hi"""\t"x\ny"\t"p\tq"\nnext')).toEqual([['say "hi"', 'x\ny', 'p\tq'], ['next']])
    const rows = [['a "b"', 'multi\nline', ''], ['\t', 'z', '"']]
    expect(parseTsv(toTsv(rows))).toEqual(rows)
  })
})

describe('mapPaste', () => {
  it('offsets from the start cell and clips past the last row and column', () => {
    const { cells, clipped } = mapPaste([['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']], { r: 3, c: 2 }, 5, 4)
    expect(cells).toEqual([
      { r: 3, c: 2, raw: 'a' },
      { r: 3, c: 3, raw: 'b' },
      { r: 4, c: 2, raw: 'd' },
      { r: 4, c: 3, raw: 'e' },
    ])
    expect(clipped).toBe(5)
  })
})
