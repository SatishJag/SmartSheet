import { generateNKeysBetween } from 'fractional-indexing'
import { MAX_SHEET_NAME_LENGTH } from '../auth/sheetName'
import { isAcceptedDate, type Column, type ColumnType } from '../model/validate'
import type { RowRecord, SheetData } from '../store/persistence'
import { createSheetFromTemplate } from '../templates'
import { parseCsv } from './csv'

export const MAX_IMPORT_ROWS = 5000
export const MAX_IMPORT_COLUMNS = 50
/** Guards the parser against a huge file before it is read into memory. */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)$/

/**
 * DATE when every non-blank value is an accepted ISO date, CHECKBOX when every one is
 * true/false, otherwise TEXT_NUMBER. Numbers are TEXT_NUMBER too (see cellValue).
 */
// shortcut: no DURATION / PREDECESSOR / picklist guessing, when users ask for smarter import.
export function inferColumnType(values: string[]): ColumnType {
  const filled = values.map((v) => v.trim()).filter((v) => v !== '')
  if (filled.length === 0) return 'TEXT_NUMBER'
  if (filled.every(isAcceptedDate)) return 'DATE'
  if (filled.every((v) => /^(true|false)$/i.test(v))) return 'CHECKBOX'
  return 'TEXT_NUMBER'
}

/** The stored value for one CSV field, or undefined to leave the cell empty. */
function cellValue(type: ColumnType, raw: string): unknown {
  const text = raw.trim()
  if (text === '') return undefined
  if (type === 'CHECKBOX') return text.toLowerCase() === 'true'
  if (type === 'DATE') return text
  // A number only when it reads back identically ("007" and "1.50" stay text, nothing is lost).
  // shortcut: text starting with "=" is stored as typed, so the grid treats it as a formula, same as typing it.
  return NUMERIC.test(text) && String(Number(text)) === text ? Number(text) : raw
}

/** Header cells with blanks named "Column N" and repeats suffixed " (2)", " (3)", ... */
function headerTitles(header: string[], width: number): string[] {
  const seen = new Set<string>()
  return Array.from({ length: width }, (_, i) => {
    const base = header[i]?.trim() || `Column ${i + 1}`
    let title = base
    for (let n = 2; seen.has(title.toLowerCase()); n++) title = `${base} (${n})`
    seen.add(title.toLowerCase())
    return title
  })
}

/** The sheet name for a file: its name without the .csv extension, or a fallback. */
export function sheetNameFromFile(fileName: string): string {
  const name = fileName.replace(/\.csv$/i, '').trim().slice(0, MAX_SHEET_NAME_LENGTH).trim()
  return name || 'Imported sheet'
}

/**
 * Builds a brand-new sheet (fresh ids, Simple list settings) from CSV text. The first record
 * is the header. Throws an Error with a user-readable message for malformed or oversized input.
 */
export function sheetFromCsv(text: string, name: string, ownerId: string): SheetData {
  const records = parseCsv(text)
  const [header = [], ...body] = records
  if (body.length > MAX_IMPORT_ROWS) {
    throw new Error(`This file has ${body.length} rows; the import limit is ${MAX_IMPORT_ROWS}. Split it and import the parts.`)
  }
  // Ragged rows are widened, never truncated, so no value is lost.
  const width = Math.max(1, header.length, ...body.map((r) => r.length))
  if (width > MAX_IMPORT_COLUMNS) {
    throw new Error(`This file has ${width} columns; the import limit is ${MAX_IMPORT_COLUMNS}.`)
  }

  const base = createSheetFromTemplate('simple-list', ownerId)
  const titles = headerTitles(header, width)
  const columns: Column[] = titles.map((title, i) => ({
    id: crypto.randomUUID(),
    title,
    type: inferColumnType(body.map((r) => r[i] ?? '')),
  }))
  const positions = generateNKeysBetween(null, null, body.length)
  const rows: RowRecord[] = body.map((r, n) => {
    const cells: Record<string, unknown> = {}
    columns.forEach((col, i) => {
      const value = cellValue(col.type, r[i] ?? '')
      if (value !== undefined) cells[col.id] = value
    })
    return { id: crypto.randomUUID(), parentId: null, position: positions[n], cells, version: 0 }
  })
  return { ...base, sheet: { ...base.sheet, name }, columns, rows }
}
