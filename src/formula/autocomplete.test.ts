import { describe, expect, it } from 'vitest'
import { applySuggestion, suggestFunctions, wordAtCaret } from './autocomplete'
import { functionInfo } from './registry'

const names = (text: string, caret = text.length) => suggestFunctions(text, caret).map((f) => f.name)

describe('wordAtCaret', () => {
  it('finds the name being typed', () => {
    expect(wordAtCaret('=SU', 3)).toEqual({ start: 1, word: 'SU' })
    expect(wordAtCaret('=1+ROU', 6)).toEqual({ start: 3, word: 'ROU' })
    expect(wordAtCaret('=IF(CO', 6)).toEqual({ start: 4, word: 'CO' })
  })
  it('finds nothing after a number, a symbol, inside a string or a [column title], or after @', () => {
    expect(wordAtCaret('=12', 3)).toBeNull()
    expect(wordAtCaret('=', 1)).toBeNull()
    expect(wordAtCaret('="SU', 4)).toBeNull()
    expect(wordAtCaret('=[Unit SU', 9)).toBeNull()
    expect(wordAtCaret('=Qty@ro', 7)).toBeNull()
    expect(wordAtCaret('=IF(', 4)).toBeNull()
  })
  it('a string that was closed again does not hide later names', () => {
    expect(wordAtCaret('="a"+SU', 7)).toEqual({ start: 5, word: 'SU' })
    expect(wordAtCaret('=[A]+SU', 7)).toEqual({ start: 5, word: 'SU' })
  })
})

describe('suggestFunctions', () => {
  it('lists functions by prefix, alphabetically, case-insensitive', () => {
    expect(names('=cou')).toEqual(['COUNT', 'COUNTIF', 'COUNTIFS'])
    expect(names('=NET')).toEqual(['NETDAYS', 'NETWORKDAYS'])
    expect(names('=zzz')).toEqual([])
  })
  it('lists every function for the first letter, and nothing without one', () => {
    expect(names('=A')).toEqual(expect.arrayContaining(['ABS', 'AND', 'ANCESTORS', 'AVG']))
    expect(names('=')).toEqual([])
  })
  it('a name already followed by ( is complete', () => {
    expect(names('=SUM(1)', 4)).toEqual([])
    expect(names('=SU(1)', 3)).toEqual(['SUBSTITUTE', 'SUM', 'SUMIF', 'SUMIFS'])
  })
})

describe('applySuggestion', () => {
  it('completes the name and opens the parenthesis', () => {
    expect(applySuggestion('=1+SU', 5, functionInfo('SUM')!)).toEqual({ text: '=1+SUM(', caret: 7 })
  })
  it('a function without arguments gets both parentheses', () => {
    expect(applySuggestion('=TOD', 4, functionInfo('TODAY')!)).toEqual({ text: '=TODAY()', caret: 8 })
  })
  it('keeps an existing parenthesis and moves the caret past it', () => {
    expect(applySuggestion('=SU(1)', 3, functionInfo('SUM')!)).toEqual({ text: '=SUM(1)', caret: 5 })
  })
  it('does nothing when there is no name at the caret', () => {
    expect(applySuggestion('=1+', 3, functionInfo('SUM')!)).toEqual({ text: '=1+', caret: 3 })
  })
})
