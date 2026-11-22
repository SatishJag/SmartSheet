/**
 * Committed totals per cost code for the Procore sync (docs/superpowers/specs/2026-11-22-procore-sync-design.md):
 * a project's counted purchase orders and subcontracts, their line items summed per cost code. Read-only.
 */
import type { CommittedCostCode, CommittedProject, CommittedRequest } from '../src/planner/types'
import { ProcoreError, type ProcoreClient } from './procore'

export const MAX_PROJECTS = 5
export const MAX_COST_CODES = 50
const MAX_CODE_CHARS = 20

/** Statuses whose commitments count, lower-cased (Procore's casing varies). Change orders are not read. */
const COUNTED = {
  work_order_contracts: new Set(['approved', 'complete']),
  purchase_order_contracts: new Set(['approved', 'partially received', 'received', 'closed']),
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const normCode = (code: string) => code.trim().toUpperCase()

export function parseCommittedRequest(body: unknown): { ok: true; value: CommittedRequest } | { ok: false; error: string } {
  if (!isObject(body) || !Array.isArray(body.projects) || body.projects.length === 0) return { ok: false, error: 'Send at least one project to sync.' }
  if (body.projects.length > MAX_PROJECTS) return { ok: false, error: `A sync takes up to ${MAX_PROJECTS} projects.` }
  const projects: CommittedRequest['projects'] = []
  let total = 0
  for (const p of body.projects) {
    if (!isObject(p) || typeof p.code !== 'string' || p.code.trim() === '' || p.code.trim().length > MAX_CODE_CHARS) return { ok: false, error: 'Each project needs a code.' }
    if (!Array.isArray(p.costCodes) || p.costCodes.length === 0) return { ok: false, error: `Send the cost codes to sync for ${p.code.trim()}.` }
    const costCodes: string[] = []
    for (const c of p.costCodes) {
      if (typeof c !== 'string' || c.trim() === '' || c.trim().length > MAX_CODE_CHARS) return { ok: false, error: `A cost code for ${p.code.trim()} is not valid.` }
      const code = normCode(c)
      if (!costCodes.includes(code)) costCodes.push(code)
    }
    total += costCodes.length
    projects.push({ code: p.code.trim(), costCodes })
  }
  if (total > MAX_COST_CODES) return { ok: false, error: `A sync takes up to ${MAX_COST_CODES} cost codes.` }
  return { ok: true, value: { projects } }
}

export interface ProcoreLineItem {
  amount?: string | number | null
  cost_code?: { code?: string | null } | null
  /** The contract's currency; amounts are in it. */
  currency_configuration?: { currency_iso_code?: string | null } | null
}

/** Line amounts summed per cost code (upper-cased), in cents. Lines without a cost code are ignored. */
export function sumByCostCode(lines: ProcoreLineItem[]): Map<string, number> {
  const sums = new Map<string, number>()
  for (const line of lines) {
    const code = line.cost_code?.code
    if (typeof code !== 'string' || code.trim() === '') continue
    const amount = Number(line.amount ?? 0)
    const cents = Number.isFinite(amount) ? Math.round(amount * 100) : 0
    const key = normCode(code)
    sums.set(key, (sums.get(key) ?? 0) + cents)
  }
  return sums
}

interface Commitment {
  id: number | string
  status?: string | null
  deleted_at?: string | null
}

/** The committed totals of `costCodes` on the Procore project whose number is `code`. */
export async function committedForProject(client: ProcoreClient, code: string, costCodes: string[], signal?: AbortSignal): Promise<CommittedProject> {
  const found = await client.getAll<{ id: number; project_number?: string | null }>(
    '/rest/v1.1/projects',
    { company_id: client.companyId, 'filters[project_number]': code, 'filters[by_status]': 'All' },
    signal,
  )
  const project = found.find((p) => (p.project_number ?? '').trim() === code)
  if (!project) return { code, status: 'not-found' }
  const query = { project_id: String(project.id) }

  const lines: ProcoreLineItem[] = []
  const awarded = new Set<string>()
  for (const kind of ['work_order_contracts', 'purchase_order_contracts'] as const) {
    const commitments = await client.getAll<Commitment>(`/rest/v1.0/${kind}`, query, signal)
    for (const c of commitments) {
      if (c.deleted_at || !COUNTED[kind].has((c.status ?? '').trim().toLowerCase())) continue
      // One commitment at a time: Procore rate-limits per company.
      const items = await client.getAll<ProcoreLineItem>(`/rest/v1.0/${kind}/${c.id}/line_items`, query, signal)
      lines.push(...items)
      for (const code of sumByCostCode(items).keys()) awarded.add(code)
    }
  }
  // Amounts are in each contract's currency: totals across currencies would mean nothing, so refuse them.
  const currencies = new Map<string, Set<string>>()
  for (const line of lines) {
    const cc = line.cost_code?.code
    const currency = line.currency_configuration?.currency_iso_code?.trim().toUpperCase()
    if (typeof cc !== 'string' || !currency) continue
    const key = normCode(cc)
    if (!currencies.has(key)) currencies.set(key, new Set())
    currencies.get(key)!.add(currency)
  }
  for (const cc of costCodes) {
    const used = [...(currencies.get(cc) ?? [])].sort()
    if (used.length > 1) throw new ProcoreError(`${cc} on ${code} has commitments in more than one currency (${used.join(', ')}); the sync can’t add them up.`)
  }
  const sums = sumByCostCode(lines)
  const known = new Set((await client.getAll<{ code?: string | null }>('/rest/v1.0/cost_codes', query, signal)).flatMap((c) => (typeof c.code === 'string' ? [normCode(c.code)] : [])))

  const result: CommittedCostCode[] = costCodes.map((cc) => ({ code: cc, committed: (sums.get(cc) ?? 0) / 100, awarded: awarded.has(cc), known: known.has(cc) }))
  return { code, status: 'ok', costCodes: result }
}
