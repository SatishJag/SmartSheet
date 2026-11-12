import { describe, expect, it } from 'vitest'
import { parseCsv } from './csv'

describe('parseCsv', () => {
  it('splits simple records on LF, CRLF and a trailing newline', () => {
    expect(parseCsv('a,b\n1,2\r\n3,4\n')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']])
  })

  it('handles quoted commas, newlines and doubled quotes', () => {
    expect(parseCsv('"a,b","line1\nline2","say ""hi"""\n')).toEqual([['a,b', 'line1\nline2', 'say "hi"']])
  })

  it('strips a UTF-8 BOM', () => {
    expect(parseCsv('﻿name,qty\nx,1')).toEqual([['name', 'qty'], ['x', '1']])
  })

  it('keeps ragged rows ragged, empty fields empty and skips blank lines', () => {
    expect(parseCsv('a,b,c\n1\n\n,,\n"",x')).toEqual([['a', 'b', 'c'], ['1'], ['', '', ''], ['', 'x']])
  })

  it('returns no records for an empty file', () => {
    expect(parseCsv('')).toEqual([])
    expect(parseCsv('﻿')).toEqual([])
  })

  it('rejects an unterminated quote instead of swallowing the file', () => {
    expect(() => parseCsv('a,b\n"oops,1\n2,3')).toThrow(/never closed/)
  })
})
