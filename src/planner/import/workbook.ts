/**
 * Reads an uploaded plan file into plain text cells, sheet by sheet: `.xlsx` (every sheet) or `.csv`
 * (one sheet). Nothing is interpreted here; see ./table.ts for finding the activities.
 * (docs/superpowers/specs/2026-11-22-plan-import-design.md)
 */
import { parseCsv } from '../../import/csv'

export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024

export interface Workbook {
  fileName: string
  sheets: { name: string; rows: string[][] }[]
}

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`

/** A real calendar date, or null (31/02 is not). */
function validDate(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? iso(y, m, d) : null
}

/** Excel serial day numbers this far apart cover 1954–2119: anything else is not a date. */
const MIN_SERIAL = 20000
const MAX_SERIAL = 80000

/** An ISO date (YYYY-MM-DD) from ISO text, day/month/year text or an Excel serial day number; else null. */
export function toIsoDate(raw: string): string | null {
  const s = raw.trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) return validDate(+m[1], +m[2], +m[3])
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
  if (m) return validDate(+m[3], +m[2], +m[1])
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s))
    if (serial < MIN_SERIAL || serial > MAX_SERIAL) return null
    const t = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000)
    return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
  }
  return null
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return iso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate())
  return String(v).trim()
}

const extension = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''

/** Reads a plan file; throws an Error with a message fit to show for a wrong type or a file too large. */
export async function readWorkbook(file: File): Promise<Workbook> {
  const ext = extension(file.name)
  if (ext !== 'xlsx' && ext !== 'csv') throw new Error('Choose an .xlsx or .csv file')
  if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error(`"${file.name}" is larger than 10 MB`)
  if (ext === 'csv') {
    const rows = parseCsv(await file.text()).map((r) => r.map((c) => c.trim()))
    return { fileName: file.name, sheets: [{ name: file.name.replace(/\.csv$/i, ''), rows }] }
  }
  // Loaded only when someone imports, so the library stays out of the main bundle.
  const { default: readXlsxFile } = await import('read-excel-file/universal')
  const sheets = await readXlsxFile(file)
  return {
    fileName: file.name,
    sheets: sheets.map((s) => ({ name: s.sheet, rows: s.data.map((row) => row.map(cellText)) })),
  }
}
