import { matchFunctions, type FunctionInfo } from './registry'

/**
 * Function-name autocomplete for the formula editor. Pure: given the text and the caret it finds the
 * name being typed (letters right before the caret that start a name, not inside a string or a
 * [column title]) and the functions that match it.
 */

export interface WordAtCaret {
  start: number
  word: string
}

/** Whether index `pos` of the formula text lies inside a "string" or a [column title]. */
function insideQuotedPart(text: string, pos: number): boolean {
  let inString = false
  let inBracket = false
  for (let i = 0; i < pos; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (inBracket) {
      if (c === ']') inBracket = false
    } else if (c === '"') inString = true
    else if (c === '[') inBracket = true
  }
  return inString || inBracket
}

/** The function name being typed at the caret, or null (a number, a string, a column title, an @row ...). */
export function wordAtCaret(text: string, caret: number): WordAtCaret | null {
  let start = caret
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) start--
  const word = text.slice(start, caret)
  if (word === '' || !/^[A-Za-z_]/.test(word)) return null
  if (insideQuotedPart(text, start)) return null
  // Not the part after `@` (as in Col@row) or a name that continues past the caret as a reference.
  if (text[start - 1] === '@') return null
  return { start, word }
}

/** Functions that complete the name at the caret; none when it is already a complete name followed by "(". */
export function suggestFunctions(text: string, caret: number): FunctionInfo[] {
  const w = wordAtCaret(text, caret)
  if (!w) return []
  if (text[caret] === '(' && matchFunctions(w.word).some((f) => f.name === w.word.toUpperCase())) return []
  return matchFunctions(w.word)
}

/** The text with the name at the caret replaced by `NAME(`, and where the caret goes (after the "("). */
export function applySuggestion(text: string, caret: number, fn: FunctionInfo): { text: string; caret: number } {
  const w = wordAtCaret(text, caret)
  if (!w) return { text, caret }
  const hasParen = text[caret] === '(' // the "(" is already there: only complete the name
  const insert = hasParen ? fn.name : fn.min === 0 ? `${fn.name}()` : `${fn.name}(`
  return { text: text.slice(0, w.start) + insert + text.slice(caret), caret: w.start + insert.length + (hasParen ? 1 : 0) }
}
