import { createContext, useContext } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

/** What every top-level section of the app gets: the backend client, who is using it, and a way to open a sheet. */
export interface ShellApi {
  client: SupabaseClient
  userId: string
  /** Opens a sheet in the Sheets section (and switches to it). */
  openSheet(sheetId: string): void
}

const ShellContext = createContext<ShellApi | null>(null)
export const ShellProvider = ShellContext.Provider

export function useShell(): ShellApi {
  const api = useContext(ShellContext)
  if (!api) throw new Error('useShell must be used inside the app shell')
  return api
}
