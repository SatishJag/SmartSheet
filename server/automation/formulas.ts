/** A cell that holds a formula is stored as text starting with "=". */
export const isFormulaCell = (v: unknown): boolean => typeof v === 'string' && v.trimStart().startsWith('=')
