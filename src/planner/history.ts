import type { SupabaseClient } from '@supabase/supabase-js'
import type { HistorySource } from './types'

/**
 * The planner's history read from Supabase (supabase/migrations/0004_planner_history.sql).
 * PLACEHOLDER: the history-database work replaces this body; the signature is the contract.
 */
export function createSupabaseHistorySource(client: SupabaseClient): HistorySource {
  void client
  const notYet = () => Promise.reject(new Error('Planner history is not implemented yet'))
  return { options: notYet, catalog: notYet, summary: notYet }
}
