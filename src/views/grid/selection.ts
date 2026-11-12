/** Pure helpers for grid ranges and clipboard text (tab-separated, Excel/Sheets-style quoting). */

export interface CellPos {
  r: number
  c: number
}

export interface Bounds {
  r0: number
  r1: number
  c0: number
  c1: number
}

/** The rectangle spanned by two corner cells, in either order. */
export function rangeBounds(a: CellPos, b: CellPos): Bounds {
  return { r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r), c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c) }
}

export const inBounds = (b: Bounds, r: number, c: number) => r >= b.r0 && r <= b.r1 && c >= b.c0 && c <= b.c1

/** Rows of cell text as tab-separated lines; a field with a tab, newline or quote is quoted. */
export function toTsv(rows: string[][]): string {
  const field = (s: string) => (/[\t\r\n"]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s)
  return rows.map((r) => r.map(field).join('\t')).join('\n')
}

/**
 * Parses clipboard text into rows of fields. Handles quoted fields (embedded tabs, newlines and
 * "" quotes) and \r\n or \n line ends; one trailing line end (Excel adds it) does not make a row.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const endField = () => {
    row.push(field)
    field = ''
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch !== '"') field += ch
      else if (text[i + 1] === '"') {
        field += '"'
        i++
      } else quoted = false
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === '\t') endField()
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endField()
      rows.push(row)
      row = []
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    endField()
    rows.push(row)
  }
  return rows
}

/**
 * Places a pasted block with its top-left cell at `start`, on a grid of `rowCount` x `colCount`
 * visible rows and columns. Cells past the last row or column are dropped and counted in `clipped`.
 */
export function mapPaste(block: string[][], start: CellPos, rowCount: number, colCount: number) {
  const cells: (CellPos & { raw: string })[] = []
  let clipped = 0
  block.forEach((fields, dr) =>
    fields.forEach((raw, dc) => {
      const r = start.r + dr
      const c = start.c + dc
      if (r < rowCount && c < colCount) cells.push({ r, c, raw })
      else clipped++
    }),
  )
  return { cells, clipped }
}
