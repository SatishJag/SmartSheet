/** Production auth: verify the user's Supabase access token, then read history as that user. */
import { createClient, type SupabaseClientOptions } from '@supabase/supabase-js'
import { createSupabaseHistorySource } from '../src/planner/history'
import type { HistorySource } from '../src/planner/types'

const serverAuth: SupabaseClientOptions<'public'>['auth'] = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
}

export function createSupabaseAuthenticator(url: string, anonKey: string): (token: string) => Promise<HistorySource | null> {
  const authClient = createClient(url, anonKey, { auth: serverAuth })
  return async (token) => {
    const { data, error } = await authClient.auth.getUser(token)
    if (error) {
      // 4xx: the token is bad or expired. Anything else (network, 5xx): verification failed.
      if (typeof error.status === 'number' && error.status >= 400 && error.status < 500) return null
      throw new Error(`Supabase auth check failed: ${error.name} ${error.status ?? ''}`.trim())
    }
    if (!data.user) return null
    // A client that sends the user's token, so row-level security applies to every history read.
    const userClient = createClient(url, anonKey, {
      auth: serverAuth,
      global: { headers: { Authorization: `Bearer ${token}` } },
    })
    return createSupabaseHistorySource(userClient)
  }
}
