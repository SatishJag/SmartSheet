import { formatPredecessors, parsePredecessors, type Pred } from '../engine/predecessor'
import type { SchedDep } from '../engine/schedule'
import { fullOrder } from '../model/hierarchy'
import type { SheetData } from './persistence'

/**
 * Translation between the predecessor column's text and the sheet's dependencies, which are
 * the source of truth. Row numbers are 1-based positions in the whole sheet's tree order
 * (`fullOrder`), unaffected by collapse, sort or filter, so the text renumbers by itself when
 * rows move. Pure.
 */

export type PredecessorInputResult = { ok: true; deps: SchedDep[] } | { ok: false; error: string }

/** Row id -> 1-based row number in tree order. */
export function rowNumbers(data: SheetData): Map<string, number> {
  return new Map(fullOrder(data.rows).map((id, i) => [id, i + 1]))
}

/** The row's incoming dependencies with their predecessors' row numbers, sorted by number. */
function incoming(data: SheetData, rowId: string, nums: Map<string, number>): Pred[] {
  return data.dependencies
    .filter((d) => d.successorId === rowId && nums.has(d.predecessorId))
    .map((d) => ({ rowNumber: nums.get(d.predecessorId)!, type: d.type, lagMinutes: d.lagMinutes }))
    .sort((a, b) => a.rowNumber - b.rowNumber)
}

/** The predecessor text of one row, e.g. "2FS +1d, 5SS". Empty when it has none. */
export function predecessorString(data: SheetData, rowId: string, nums: Map<string, number> = rowNumbers(data)): string {
  return formatPredecessors(incoming(data, rowId, nums), data.sheet.calendar.hoursPerDay)
}

/** The predecessor text of every row that has predecessors, computed in one pass. */
export function predecessorStrings(data: SheetData): Map<string, string> {
  const nums = rowNumbers(data)
  const bySuccessor = new Map<string, Pred[]>()
  for (const d of data.dependencies) {
    const n = nums.get(d.predecessorId)
    if (n === undefined) continue
    const list = bySuccessor.get(d.successorId) ?? []
    list.push({ rowNumber: n, type: d.type, lagMinutes: d.lagMinutes })
    bySuccessor.set(d.successorId, list)
  }
  const hoursPerDay = data.sheet.calendar.hoursPerDay
  return new Map(
    [...bySuccessor].map(([id, preds]) => [id, formatPredecessors(preds.sort((a, b) => a.rowNumber - b.rowNumber), hoursPerDay)]),
  )
}

/** One line per predecessor, "<number>: <name>"; the name is the first TEXT_NUMBER column's value. */
export function predecessorTooltip(data: SheetData, rowId: string, nums: Map<string, number> = rowNumbers(data)): string {
  const nameCol = data.columns.find((c) => c.type === 'TEXT_NUMBER')
  const byNumber = new Map([...nums].map(([id, n]) => [n, id]))
  return incoming(data, rowId, nums)
    .map(({ rowNumber }) => {
      const row = data.rows.find((r) => r.id === byNumber.get(rowNumber))
      const value = nameCol ? row?.cells[nameCol.id] : undefined
      const name = value === null || value === undefined || String(value).trim() === '' ? `Row ${rowNumber}` : String(value)
      return `${rowNumber}: ${name}`
    })
    .join('\n')
}

/** Parse the user's predecessor text into the dependencies of successor `rowId`. */
export function parsePredecessorInput(data: SheetData, rowId: string, raw: string): PredecessorInputResult {
  const parsed = parsePredecessors(raw, data.sheet.calendar.hoursPerDay)
  if (!parsed.ok) return parsed
  const order = fullOrder(data.rows)
  const seen = new Set<number>()
  const deps: SchedDep[] = []
  for (const p of parsed.value) {
    const predecessorId = order[p.rowNumber - 1]
    if (predecessorId === undefined) return { ok: false, error: `Row ${p.rowNumber} does not exist` }
    if (predecessorId === rowId) return { ok: false, error: 'A row cannot depend on itself' }
    if (seen.has(p.rowNumber)) return { ok: false, error: `Row ${p.rowNumber} is listed more than once` }
    seen.add(p.rowNumber)
    deps.push({ predecessorId, successorId: rowId, type: p.type, lagMinutes: p.lagMinutes })
  }
  return { ok: true, deps }
}
