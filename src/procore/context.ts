/**
 * The Procore company and project the /procore page was opened on
 * (docs/superpowers/specs/2026-11-22-procore-panel-design.md). The full-screen app gets them in its address
 * (`?company=…&project=…`, filled in by Procore); the side panel gets them in Procore's `setup` message,
 * which it asks for with `initialize`. Only Procore's own origins are spoken to or listened to.
 */
import { isProcoreOrigin } from './origins'

export interface ProcoreContext {
  companyId: string
  projectId: string
}

const ID = /^\d{1,20}$/

const asId = (v: unknown): string | null => {
  const s = typeof v === 'number' && Number.isInteger(v) ? String(v) : typeof v === 'string' ? v : ''
  return ID.test(s) ? s : null
}

/** The context in the page address, or null when either id is missing or not a number. */
export function contextFromSearch(search: string): ProcoreContext | null {
  const q = new URLSearchParams(search)
  const companyId = asId(q.get('company'))
  const projectId = asId(q.get('project'))
  return companyId && projectId ? { companyId, projectId } : null
}

/** The origin of a referrer URL, or '' when it is not one. */
function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * Asks the Procore window that framed this page for its context (only when the referrer is Procore) and
 * calls back with the company and project from its `setup` message. Returns a function that stops listening.
 */
export function listenForProcoreContext(win: Window, referrer: string, onContext: (c: ProcoreContext) => void): () => void {
  const onMessage = (event: MessageEvent) => {
    if (!isProcoreOrigin(event.origin)) return
    const data = event.data as { type?: unknown; context?: { company_id?: unknown; project_id?: unknown } } | null
    if (!data || typeof data !== 'object' || data.type !== 'setup' || !data.context) return
    const companyId = asId(data.context.company_id)
    const projectId = asId(data.context.project_id)
    if (companyId && projectId) onContext({ companyId, projectId })
  }
  win.addEventListener('message', onMessage)
  const parentOrigin = originOf(referrer)
  if (isProcoreOrigin(parentOrigin)) win.parent.postMessage({ type: 'initialize' }, parentOrigin)
  return () => win.removeEventListener('message', onMessage)
}
