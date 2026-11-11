export const MAX_SHEET_NAME_LENGTH = 100

/** A sheet name as the user typed it: trimmed, non-empty, at most MAX_SHEET_NAME_LENGTH characters. */
export function validateSheetName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.trim()
  if (name === '') return { ok: false, error: 'Enter a sheet name' }
  if (name.length > MAX_SHEET_NAME_LENGTH) {
    return { ok: false, error: `Sheet names can be at most ${MAX_SHEET_NAME_LENGTH} characters` }
  }
  return { ok: true, name }
}
