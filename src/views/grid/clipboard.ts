/**
 * Pure helpers for the grid's range selection and clipboard: rectangle math over display
 * indices, TSV (tab-separated values) parsing and serialising in the dialect spreadsheet apps
 * put on the clipboard, and planning where pasted values land.
 *
 * Nothing here knows about the DOM or the store: positions are indices into the grid's visible
 * rows and its columns, so selection survives virtualization.
 */

/** A cell position as indices into the visible rows and the sheet columns. */
export interface CellPos {
  row: number
  col: number
}

/** An inclusive rectangle of cells. Always normalised: top <= bottom, left <= right. */
export interface CellRange {
  top: number
  left: number
  bottom: number
  right: number
}

/** The rectangle spanned by two corners, in any order. */
export function rangeFrom(a: CellPos, b: CellPos): CellRange {
  return {
    top: Math.min(a.row, b.row),
    bottom: Math.max(a.row, b.row),
    left: Math.min(a.col, b.col),
    right: Math.max(a.col, b.col),
  }
}

export function rangeContains(r: CellRange, row: number, col: number): boolean {
  return row >= r.top && row <= r.bottom && col >= r.left && col <= r.right
}

export const rangeHeight = (r: CellRange) => r.bottom - r.top + 1
export const rangeWidth = (r: CellRange) => r.right - r.left + 1
export const rangeSize = (r: CellRange) => rangeHeight(r) * rangeWidth(r)

/** Every position in the rectangle, row by row, left to right. */
export function rangeCells(r: CellRange): CellPos[] {
  const out: CellPos[] = []
  for (let row = r.top; row <= r.bottom; row++) for (let col = r.left; col <= r.right; col++) out.push({ row, col })
  return out
}

/**
 * Parses clipboard text as TSV. Rows end at `\n`, `\r\n` or `\r`; one trailing line break is
 * dropped (spreadsheet apps add it). A field that starts with `"` and has a matching closing
 * quote right before a tab, line break or the end is quoted: it may contain tabs and line
 * breaks, and `""` inside it is one `"`. Any other quote is literal text (e.g. `5" pipe`).
 * Empty text is one empty cell, so pasting a copied blank cell clears the target.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let i = 0
  const n = text.length
  const atLineBreak = (j: number) => text[j] === '\n' || text[j] === '\r'
  // Index just past the line break starting at j.
  const skipLineBreak = (j: number) => (text[j] === '\r' && text[j + 1] === '\n' ? j + 2 : j + 1)

  for (;;) {
    let field: string | null = null
    if (text[i] === '"') {
      const quoted = readQuoted(text, i)
      if (quoted && (quoted.end === n || text[quoted.end] === '\t' || atLineBreak(quoted.end))) {
        field = quoted.value
        i = quoted.end
      }
    }
    if (field === null) {
      let j = i
      while (j < n && text[j] !== '\t' && !atLineBreak(j)) j++
      field = text.slice(i, j)
      i = j
    }
    row.push(field)

    if (i >= n) {
      rows.push(row)
      break
    }
    if (text[i] === '\t') {
      i++
      continue
    }
    // A line break: end the row, unless it is the final one.
    rows.push(row)
    row = []
    i = skipLineBreak(i)
    if (i >= n) break
  }
  return rows
}

/** Reads a quoted field starting at the opening quote; null when it never closes. */
function readQuoted(text: string, start: number): { value: string; end: number } | null {
  let value = ''
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      if (text[i + 1] === '"') {
        value += '"'
        i += 2
        continue
      }
      return { value, end: i + 1 }
    }
    value += ch
    i++
  }
  return null
}

/**
 * Serialises cells as TSV: tabs between fields, `\n` between rows, no trailing line break.
 * A field is quoted (with `"` doubled) only when it contains a tab or line break or starts
 * with a quote, so that `parseTsv` and spreadsheet apps read it back unchanged.
 */
export function serializeTsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(quoteField).join('\t')).join('\n')
}

function quoteField(value: string): string {
  if (!/[\t\n\r]/.test(value) && !value.startsWith('"')) return value
  return `"${value.replace(/"/g, '""')}"`
}

/** One value to write: the target position and the raw text. */
export interface PasteCell extends CellPos {
  value: string
}

export interface PastePlan {
  cells: PasteCell[]
  /** The rectangle the paste covers (clipped to the grid). */
  range: CellRange
  /** Pasted values that fell past the last row or column and were dropped. */
  clipped: number
}

/**
 * Where pasted values go. The block starts at the selection's top-left cell. When the
 * selection is larger than the block and a whole multiple of it in both directions (e.g. one
 * value into many cells), the block is repeated to fill the selection, as spreadsheets do.
 * Values past the last row or column are dropped, never added as new rows.
 */
export function planPaste(values: string[][], selection: CellRange, rowCount: number, colCount: number): PastePlan {
  const h = values.length
  const w = Math.max(0, ...values.map((r) => r.length))
  if (h === 0 || w === 0) return { cells: [], range: { ...selection, bottom: selection.top, right: selection.left }, clipped: 0 }

  const selH = rangeHeight(selection)
  const selW = rangeWidth(selection)
  const tile = (selH > h || selW > w) && selH % h === 0 && selW % w === 0
  const outH = tile ? selH : h
  const outW = tile ? selW : w

  const cells: PasteCell[] = []
  let clipped = 0
  for (let dr = 0; dr < outH; dr++) {
    for (let dc = 0; dc < outW; dc++) {
      const row = selection.top + dr
      const col = selection.left + dc
      // A short row in ragged TSV pastes as empty.
      const value = values[dr % h][dc % w] ?? ''
      if (row >= rowCount || col >= colCount) clipped++
      else cells.push({ row, col, value })
    }
  }
  const range = {
    top: selection.top,
    left: selection.left,
    bottom: Math.min(rowCount - 1, selection.top + outH - 1),
    right: Math.min(colCount - 1, selection.left + outW - 1),
  }
  return { cells, range, clipped }
}

/** One cell that a paste, cut or clear could not change, and why. */
export interface Rejection {
  /** Where, e.g. "row 3 Status". */
  where: string
  reason: string
}

const MAX_LISTED = 3

/**
 * One summary notice for the cells a paste could not write, e.g. `2 cells were not pasted:
 * row 3 Status (Choose one of: …); row 1 End (read-only)`. Lists at most three; null when
 * there is nothing to report.
 */
export function describeRejections(rejected: readonly Rejection[], clipped = 0, verb = 'pasted'): string | null {
  const total = rejected.length + clipped
  if (total === 0) return null
  const parts = rejected.slice(0, MAX_LISTED).map((r) => `${r.where} (${r.reason})`)
  const unlisted = rejected.length - parts.length
  if (unlisted > 0) parts.push(`and ${unlisted} more`)
  if (clipped > 0) parts.push(`${clipped} past the end of the sheet`)
  return `${total} ${total === 1 ? 'cell was' : 'cells were'} not ${verb}: ${parts.join('; ')}`
}
