/**
 * Sync with Procore (docs/superpowers/specs/2026-11-22-procore-sync-design.md): on a Plan with AI sheet,
 * fills Committed (Procore) and Awarded from Procore and says what it did. The sheet view shows it to
 * owners and editors only.
 */
import { useEffect, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useSheetStore, useSheetStoreApi } from '../store/SheetStoreContext'
import { Icon } from '../ui/Icon'
import { getAccessToken, requestCommitted } from './plannerApi'
import { applySync, canSyncProcore, checkSyncLimits, collectSync, syncResultText } from './syncProcore'

export const NOTHING_TO_SYNC = 'Nothing to sync: no rows have both a project in Procore and a cost code.'

/** The reason in a sync failure, without the layers of "failed:" prefixes the server and client add. */
function reason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^The planning server failed: /, '').replace(/^Could not sync with Procore: /, '')
}

export function ProcoreSyncButton({ client }: { client: SupabaseClient }) {
  const store = useSheetStoreApi()
  const show = useSheetStore((s) => (s.data ? canSyncProcore(s.data) : false))
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const running = useRef<AbortController | null>(null)

  useEffect(() => () => running.current?.abort(), [])

  if (!show) return null

  async function sync() {
    const data = store.getState().data
    if (!data) return
    const plan = collectSync(data)
    if (plan.request.projects.length === 0) {
      setResult(NOTHING_TO_SYNC)
      return
    }
    const tooMuch = checkSyncLimits(plan)
    if (tooMuch) {
      setResult(`Could not sync: ${tooMuch}`)
      return
    }
    const controller = new AbortController()
    running.current = controller
    setBusy(true)
    try {
      const token = await getAccessToken(client)
      const response = await requestCommitted(token, plan.request, { signal: controller.signal })
      if (controller.signal.aborted) return
      const summary = applySync(store, plan, response)
      setResult(syncResultText(summary, new Date()))
    } catch (err) {
      if (controller.signal.aborted) return
      setResult(`Could not sync: ${reason(err)}`)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
      if (running.current === controller) running.current = null
    }
  }

  return (
    <span className="procore-sync">
      <button type="button" className="btn" onClick={() => void sync()} disabled={busy} title="Fill Committed (Procore) and Awarded from Procore for this sheet's projects and cost codes">
        <Icon name="cloud" size={16} />
        {busy ? 'Syncing…' : 'Sync with Procore'}
      </button>
      {result && (
        <span role="status" className="procore-sync-result">
          {result}
        </span>
      )}
    </span>
  )
}
