import { formatPredecessors, parsePredecessors, type Pred } from '../engine/predecessor'
import type { SchedDep } from '../engine/schedule'
import { fullOrder } from '../model/hierarchy'
import type { RowRecord, SheetData } from './persistence'

/**
 * Translation between the predecessor column's text and the sheet's dependencies, which are
 * the source of truth. Row numbers are 1-based positions in the whole sheet's tree order
 * (`fullOrder`), unaffected by collapse, sort or filter, so the text renumbers by itself when
 * rows move. Pure.
 */

export type PredecessorInputResult = { ok: true; deps: SchedDep[] } | { ok: false; error: string }

/** Lookups derived from one SheetData, built once and shared by every caller. */
export interface SheetLookup {
  /** Row ids in tree order. */
  order: string[]
  /** Row id -> 1-based row number. */
  nums: Map<string, number>
  byId: Map<string, RowRecord>
  /** Successor id -> its incoming dependencies as predecessors, sorted by row number. */
  incoming: Map<string, (Pred & { predecessorId: string })[]>
}

// SheetData is treated as immutable (the store replaces it on every change), so a lookup built
// for one object stays valid for it. Callers must not mutate data after reading through it.
const lookups = new WeakMap<SheetData, SheetLookup>()

/** The (cached) lookups for `data`: one tree walk per SheetData object, however many cells ask. */
export function sheetLookup(data: SheetData): SheetLookup {
  const cached = lookups.get(data)
  if (cached) return cached
  const order = fullOrder(data.rows)
  const nums = new Map(order.map((id, i) => [id, i + 1]))
  const incoming: SheetLookup['incoming'] = new Map()
  for (const d of data.dependencies) {
    const rowNumber = nums.get(d.predecessorId)
    if (rowNumber === undefined) continue
    const list = incoming.get(d.successorId) ?? []
    list.push({ rowNumber, type: d.type, lagMinutes: d.lagMinutes, predecessorId: d.predecessorId })
    incoming.set(d.successorId, list)
  }
  for (const list of incoming.values()) list.sort((a, b) => a.rowNumber - b.rowNumber)
  const lookup: SheetLookup = { order, nums, byId: new Map(data.rows.map((r) => [r.id, r])), incoming }
  lookups.set(data, lookup)
  return lookup
}

/** Row id -> 1-based row number in tree order. */
export function rowNumbers(data: SheetData): Map<string, number> {
  return sheetLookup(data).nums
}

const format = (data: SheetData, preds: Pred[]) =>
  formatPredecessors(
    preds.map(({ rowNumber, type, lagMinutes }) => ({ rowNumber, type, lagMinutes })),
    data.sheet.calendar.hoursPerDay,
  )

/** The predecessor text of one row, e.g. "2FS +1d, 5SS". Empty when it has none. */
export function predecessorString(data: SheetData, rowId: string): string {
  return format(data, sheetLookup(data).incoming.get(rowId) ?? [])
}

/** The predecessor text of every row that has predecessors. */
export function predecessorStrings(data: SheetData): Map<string, string> {
  return new Map([...sheetLookup(data).incoming].map(([id, preds]) => [id, format(data, preds)]))
}

/** One line per predecessor, "<number>: <name>"; the name is the first TEXT_NUMBER column's value. */
export function predecessorTooltip(data: SheetData, rowId: string): string {
  const { incoming, byId } = sheetLookup(data)
  const nameCol = data.columns.find((c) => c.type === 'TEXT_NUMBER')
  return (incoming.get(rowId) ?? [])
    .map(({ rowNumber, predecessorId }) => {
      const value = nameCol ? byId.get(predecessorId)?.cells[nameCol.id] : undefined
      const name = value === null || value === undefined || String(value).trim() === '' ? `Row ${rowNumber}` : String(value)
      return `${rowNumber}: ${name}`
    })
    .join('\n')
}

/** Parse the user's predecessor text into the dependencies of successor `rowId`. */
export function parsePredecessorInput(data: SheetData, rowId: string, raw: string): PredecessorInputResult {
  const parsed = parsePredecessors(raw, data.sheet.calendar.hoursPerDay)
  if (!parsed.ok) return parsed
  const { order } = sheetLookup(data)
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
