import { useEffect } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useSheetStoreApi } from '../store/SheetStoreContext'
import { createAutomationRuntime } from './runtime'

/** Mounted inside an open sheet: runs that sheet's row-change rules for the signed-in user. Renders nothing. */
export function AutomationRuntime({ client }: { client: SupabaseClient }) {
  const store = useSheetStoreApi()
  useEffect(() => {
    const runtime = createAutomationRuntime({ client, store })
    runtime.start()
    return () => runtime.stop()
  }, [client, store])
  return null
}
