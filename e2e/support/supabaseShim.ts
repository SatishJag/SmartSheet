/**
 * Stand-in for `src/lib/supabase.ts`, used ONLY when Vite runs in mode `e2e` (see the
 * `e2eFakeSupabase` plugin in `vite.config.ts`). The config reader is the real one; the client
 * is the in-memory fake backed by localStorage.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SupabaseConfig } from '../../src/lib/supabase'
import { createFakeSupabase } from './fakeSupabase'

export { getSupabaseConfig } from '../../src/lib/supabase'
export type { SupabaseConfig } from '../../src/lib/supabase'

export function createSupabaseClient(_config: SupabaseConfig): SupabaseClient {
  return createFakeSupabase({ storage: window.localStorage }) as unknown as SupabaseClient
}
