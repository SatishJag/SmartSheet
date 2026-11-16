/**
 * Which rows are locked, per sheet, as known in this browser. The sheet store asks `isRowLocked`
 * before it accepts an edit or a delete (a locked row is read-only until a rule or the owner
 * unlocks it); the automation runtime fills it from `row_locks` when a sheet opens and keeps it in
 * step when a lock / unlock action runs. A plain module on purpose: the store has no React and no
 * Supabase in it, and an empty registry costs one Map lookup.
 */
const bySheet = new Map<string, Set<string>>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export const LOCKED_MESSAGE = 'This row is locked. Unlock it (Automation) to change it.'

export function isRowLocked(sheetId: string, rowId: string): boolean {
  return bySheet.get(sheetId)?.has(rowId) === true
}

export function lockedRowIds(sheetId: string): ReadonlySet<string> {
  return bySheet.get(sheetId) ?? new Set()
}

export function setLockedRows(sheetId: string, rowIds: Iterable<string>): void {
  bySheet.set(sheetId, new Set(rowIds))
  emit()
}

export function setRowLocked(sheetId: string, rowId: string, locked: boolean): void {
  const set = bySheet.get(sheetId) ?? new Set<string>()
  if (locked) set.add(rowId)
  else set.delete(rowId)
  bySheet.set(sheetId, set)
  emit()
}

export function clearLocks(sheetId: string): void {
  bySheet.delete(sheetId)
  emit()
}

/** Called whenever any lock changes (so views can redraw). Returns the unsubscribe function. */
export function onLocksChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
