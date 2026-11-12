import { isFormula } from '../formula/sheetFormulas'
import {
  COLUMN_TYPE_LABELS,
  columnLock,
  isPicklistType,
  normalizeOptions,
  renameFormulaReferences,
  USER_COLUMN_TYPES,
  validateColumnTitle,
} from '../model/columns'
import { fullOrder } from '../model/hierarchy'
import { validateCell, type Column, type ColumnType } from '../model/validate'
import type { Persistence, RowRecord, SheetData } from './persistence'
import type { ActionResult, SheetState } from './sheetStore'

export type AddColumnResult = { ok: true; id: string } | { ok: false; error: string }

/** The column-management actions of the sheet store. */
export interface ColumnActions {
  /**
   * Adds a column after `afterColId` (at the end when omitted). Dropdown types need `options`.
   * Returns the new column's id.
   */
  addColumn(title: string, type: ColumnType, options?: string[], afterColId?: string): AddColumnResult
  /** Renames a column and rewrites `[Old Title]` references in formula cells to the new title. */
  renameColumn(colId: string, title: string): ActionResult
  /** Deletes a column and its values (not the primary column, nor schedule columns while dependencies are on). */
  deleteColumn(colId: string): ActionResult
  /** Replaces a dropdown column's options. Existing values are kept, even ones no longer listed. */
  setColumnOptions(colId: string, options: string[]): ActionResult
  /**
   * Changes a column's type (and drops any special role). Existing values are re-validated for the
   * new type: values that fit are kept (normalized), the others are cleared and a notice says how many.
   */
  changeColumnType(colId: string, type: ColumnType, options?: string[]): ActionResult
}

/** A queued persistence job, as the store's queue runs it (see `Job` in sheetStore.ts). */
interface QueuedJob {
  key: string
  value?: unknown
  run(job: QueuedJob): Promise<void>
}

/** What the column actions need from the store's internals. */
export interface ColumnActionContext {
  p: Persistence
  get(): SheetState
  /** Replace data and recompute the schedule. */
  commit(data: SheetData, extra?: Partial<SheetState>): void
  enqueue(job: QueuedJob): void
  /** Keys of jobs that ran out of retries (shared with the store). */
  failedKeys: Set<string>
  /** Rows whose insert has not succeeded yet; their insert carries their current cells. */
  unpersisted: Set<string>
  /** How to re-queue each failed column job; `retryFailed` calls these. */
  retryers: Map<string, () => void>
}

/** A stored value as the text a user would type (the inverse of validateCell, as far as it goes). */
function asTyped(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

const isEmptyValue = (v: unknown) => v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0)

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function createColumnActions(ctx: ColumnActionContext): ColumnActions {
  const { p, get, commit, enqueue, failedKeys, unpersisted, retryers } = ctx

  /** Columns added locally whose insert has not succeeded yet. */
  const unpersistedColumns = new Set<string>()
  /** Per column, rows whose value must be written by the next bulk save of that column. */
  const pendingCells = new Map<string, Set<string>>()

  /** Insert the column if it is new, otherwise write its definition (always the latest one). */
  function saveColumn(colId: string): void {
    const key = `col:${colId}`
    retryers.set(key, () => saveColumn(colId))
    enqueue({
      key,
      async run() {
        const data = get().data
        const index = data?.columns.findIndex((c) => c.id === colId) ?? -1
        if (!data || index < 0) return // deleted meanwhile
        const col = data.columns[index]
        if (unpersistedColumns.has(colId)) {
          await p.insertColumn(data.sheet.id, col, index)
          unpersistedColumns.delete(colId)
        } else {
          await p.updateColumn(col)
        }
      },
    })
  }

  function saveOrder(): void {
    const key = 'colorder'
    retryers.set(key, saveOrder)
    enqueue({
      key,
      async run() {
        const data = get().data
        if (data) await p.saveColumnOrder(data.sheet.id, data.columns.map((c) => c.id))
      },
    })
  }

  function removeColumn(sheetId: string, colId: string): void {
    const key = `coldel:${colId}`
    retryers.set(key, () => removeColumn(sheetId, colId))
    enqueue({
      key,
      async run() {
        if (unpersistedColumns.has(colId)) {
          unpersistedColumns.delete(colId) // never reached the database
          return
        }
        await p.deleteColumn(sheetId, colId)
      },
    })
  }

  /**
   * Writes the current value of one column on the given rows in one bulk call. The values are read
   * when the job runs, so a later edit is never overwritten by an older one.
   */
  function saveColumnCells(colId: string, rowIds: Iterable<string>): void {
    let pending = pendingCells.get(colId)
    if (!pending) pendingCells.set(colId, (pending = new Set()))
    for (const id of rowIds) pending.add(id)
    const key = `colcells:${colId}`
    retryers.set(key, () => saveColumnCells(colId, []))
    enqueue({
      key,
      async run() {
        const data = get().data
        const batch = [...(pendingCells.get(colId) ?? [])]
        if (!data || batch.length === 0) return
        if (!data.columns.some((c) => c.id === colId)) {
          pendingCells.delete(colId) // the column was deleted; its values went with it
          return
        }
        const byId = new Map(data.rows.map((r) => [r.id, r]))
        const values: Record<string, unknown> = {}
        for (const id of batch) {
          const row = byId.get(id)
          // Deleted rows need nothing; a row not inserted yet carries its cells in its insert.
          if (row && !unpersisted.has(id)) values[id] = row.cells[colId]
        }
        if (Object.keys(values).length > 0) await p.saveColumnCells(data.sheet.id, colId, values)
        for (const id of batch) pendingCells.get(colId)?.delete(id)
      },
    })
  }

  /** Replaces one column in `data.columns`. */
  const withColumn = (data: SheetData, col: Column): SheetData => ({
    ...data,
    columns: data.columns.map((c) => (c.id === col.id ? col : c)),
  })

  return {
    addColumn(title, type, options, afterColId) {
      const data = get().data
      if (!data) return { ok: false, error: 'Sheet is not loaded' }
      if (!USER_COLUMN_TYPES.includes(type)) return { ok: false, error: `Columns cannot be added as ${COLUMN_TYPE_LABELS[type]}` }
      const valid = validateColumnTitle(title, data.columns)
      if (!valid.ok) return valid
      let index = data.columns.length
      if (afterColId !== undefined) {
        const after = data.columns.findIndex((c) => c.id === afterColId)
        if (after < 0) return { ok: false, error: `Unknown column ${afterColId}` }
        index = after + 1
      }
      const col: Column = { id: crypto.randomUUID(), title: valid.title, type }
      if (isPicklistType(type)) {
        const opts = normalizeOptions(options ?? [])
        if (!opts.ok) return opts
        col.options = opts.options
      }
      const columns = [...data.columns.slice(0, index), col, ...data.columns.slice(index)]
      commit({ ...data, columns })
      unpersistedColumns.add(col.id)
      saveColumn(col.id)
      saveOrder() // positions after the new column shift (and earlier deletes may have left gaps)
      return { ok: true, id: col.id }
    },

    renameColumn(colId, title) {
      const data = get().data
      if (!data) return { ok: false, error: 'Sheet is not loaded' }
      const col = data.columns.find((c) => c.id === colId)
      if (!col) return { ok: false, error: `Unknown column ${colId}` }
      const valid = validateColumnTitle(title, data.columns, colId)
      if (!valid.ok) return valid
      if (valid.title === col.title) return { ok: true }

      // Formulas name columns by title: point [Old] references at the new title.
      const touched = new Map<string, Set<string>>() // column id -> row ids
      const rows = data.rows.map((r): RowRecord => {
        let next: Record<string, unknown> | null = null
        for (const [cid, v] of Object.entries(r.cells)) {
          if (!isFormula(v)) continue
          const rewritten = renameFormulaReferences(v, col.title, valid.title)
          if (rewritten === v) continue
          next ??= { ...r.cells }
          next[cid] = rewritten
          if (!touched.has(cid)) touched.set(cid, new Set())
          touched.get(cid)!.add(r.id)
        }
        return next ? { ...r, cells: next } : r
      })
      commit({ ...withColumn(data, { ...col, title: valid.title }), rows: touched.size > 0 ? rows : data.rows })
      saveColumn(colId)
      for (const [cid, ids] of touched) saveColumnCells(cid, ids)
      return { ok: true }
    },

    deleteColumn(colId) {
      const data = get().data
      if (!data) return { ok: false, error: 'Sheet is not loaded' }
      if (!data.columns.some((c) => c.id === colId)) return { ok: false, error: `Unknown column ${colId}` }
      const locked = columnLock(data, colId, 'delete')
      if (locked) return { ok: false, error: locked }

      const rows = data.rows.map((r): RowRecord => {
        if (!(colId in r.cells)) return r
        const { [colId]: _removed, ...rest } = r.cells
        return { ...r, cells: rest }
      })
      commit(
        { ...data, columns: data.columns.filter((c) => c.id !== colId), rows },
        { errors: get().errors.filter((e) => e.colId !== colId) },
      )
      // Nothing of this column needs saving any more: its delete removes every value at once.
      for (const key of [...failedKeys]) {
        const ofColumn =
          (key.startsWith('cell:') && key.endsWith(`:${colId}`)) || key === `col:${colId}` || key === `colcells:${colId}`
        if (ofColumn) {
          failedKeys.delete(key)
          retryers.delete(key)
        }
      }
      pendingCells.delete(colId)
      removeColumn(data.sheet.id, colId)
      return { ok: true }
    },

    setColumnOptions(colId, options) {
      const data = get().data
      if (!data) return { ok: false, error: 'Sheet is not loaded' }
      const col = data.columns.find((c) => c.id === colId)
      if (!col) return { ok: false, error: `Unknown column ${colId}` }
      if (!isPicklistType(col.type)) return { ok: false, error: 'Only dropdown columns have options' }
      const opts = normalizeOptions(options)
      if (!opts.ok) return opts
      commit(withColumn(data, { ...col, options: opts.options }))
      saveColumn(colId)
      return { ok: true }
    },

    changeColumnType(colId, type, options) {
      const data = get().data
      if (!data) return { ok: false, error: 'Sheet is not loaded' }
      const col = data.columns.find((c) => c.id === colId)
      if (!col) return { ok: false, error: `Unknown column ${colId}` }
      const locked = columnLock(data, colId, 'retype')
      if (locked) return { ok: false, error: locked }
      if (!USER_COLUMN_TYPES.includes(type)) return { ok: false, error: `Columns cannot be changed to ${COLUMN_TYPE_LABELS[type]}` }
      if (type === col.type) return isPicklistType(type) && options ? get().setColumnOptions(colId, options) : { ok: true }

      // The role went with the old type (a status dropdown, a % complete number, ...).
      const next: Column = { id: col.id, title: col.title, type }
      if (col.systemType !== undefined) next.systemType = col.systemType
      if (isPicklistType(type)) {
        const opts = normalizeOptions(options ?? col.options ?? [])
        if (!opts.ok) return opts
        next.options = opts.options
      }

      let order: Map<string, number> | null = null
      const rowNumber = (id: string) => (order ??= new Map(fullOrder(data.rows).map((rid, i) => [rid, i + 1]))).get(id) ?? 0
      let cleared = 0
      const changed: string[] = []
      const rows = data.rows.map((r): RowRecord => {
        if (!(colId in r.cells)) return r
        const v = r.cells[colId]
        let value: unknown
        if (isEmptyValue(v)) value = undefined
        else if (isFormula(v)) value = v
        else {
          const res = validateCell(next, asTyped(v), {
            rowCount: data.rows.length,
            ownRowNumber: rowNumber(r.id),
            hoursPerDay: data.sheet.calendar.hoursPerDay,
            dependenciesEnabled: data.sheet.dependenciesEnabled,
          })
          value = res.ok && !isEmptyValue(res.value) ? res.value : undefined
          if (!res.ok) cleared++
        }
        if (value !== undefined && sameValue(value, v)) return r
        changed.push(r.id)
        const { [colId]: _old, ...rest } = r.cells
        return { ...r, cells: value === undefined ? rest : { ...rest, [colId]: value } }
      })

      const notices =
        cleared > 0
          ? [...get().notices, `Changed "${col.title}" to ${COLUMN_TYPE_LABELS[type]}: cleared ${plural(cleared, 'value')} that did not fit`]
          : get().notices
      commit(
        { ...withColumn(data, next), rows: changed.length > 0 ? rows : data.rows },
        { notices, errors: get().errors.filter((e) => e.colId !== colId) },
      )
      saveColumn(colId)
      if (changed.length > 0) saveColumnCells(colId, changed)
      return { ok: true }
    },
  }
}
