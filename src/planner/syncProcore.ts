/**
 * The sheet side of the Procore sync (docs/superpowers/specs/2026-11-22-procore-sync-design.md): which
 * rows carry a project and a cost code, and writing the committed totals back as two columns in one
 * store batch. Pure apart from the store calls in applySync.
 */
import type { StoreApi } from 'zustand/vanilla'
import type { SheetData } from '../store/persistence'
import type { SheetState } from '../store/sheetStore'
import { BASIS_COLUMN_TITLE, COST_CODE_COLUMN_TITLE, DELIVERY_SITE_COLUMN_TITLE, PROJECT_COLUMN_TITLE } from './sheetFromDraft'
import type { CommittedRequest, CommittedResponse } from './types'

export const COMMITTED_COLUMN_TITLE = 'Committed (Procore)'
export const AWARDED_COLUMN_TITLE = 'Awarded'
/** The project column's title on sheets created before it was renamed "Project". */
export const OLD_PROJECT_COLUMN_TITLE = 'Procore project'

const byTitle = (data: SheetData, title: string) => data.columns.find((c) => c.title.trim().toLowerCase() === title.toLowerCase())

const projectColumn = (data: SheetData) => byTitle(data, PROJECT_COLUMN_TITLE) ?? byTitle(data, OLD_PROJECT_COLUMN_TITLE)

/** A Plan with AI sheet the sync can fill: it has a Cost code column and a project column. */
export function canSyncProcore(data: SheetData): boolean {
  return Boolean(byTitle(data, COST_CODE_COLUMN_TITLE) && projectColumn(data))
}

export interface SyncGroup {
  project: string
  costCode: string
  rowIds: string[]
  /** How many plan items share this project + cost code (summary rows; a flat sheet is one item). */
  items: number
}

export interface SyncPlan {
  request: CommittedRequest
  groups: SyncGroup[]
}

/** The code in a "CODE — Name" cell, or the whole trimmed text when typed by hand. */
function codeOf(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  const dash = text.indexOf(' — ')
  return (dash >= 0 ? text.slice(0, dash) : text).trim()
}

/** The sheet's rows that carry both a project and a cost code, grouped by the pair, in sheet order. */
export function collectSync(data: SheetData): SyncPlan {
  const project = projectColumn(data)
  const cost = byTitle(data, COST_CODE_COLUMN_TITLE)
  if (!project || !cost) return { request: { projects: [] }, groups: [] }
  const parents = new Set(data.rows.flatMap((r) => (r.parentId ? [r.parentId] : [])))
  const flat = parents.size === 0
  const groups = new Map<string, SyncGroup>()
  for (const row of data.rows) {
    const p = codeOf(row.cells[project.id])
    const c = codeOf(row.cells[cost.id]).toUpperCase()
    if (!p || !c) continue
    const key = `${p}\u0000${c}`
    let g = groups.get(key)
    if (!g) {
      g = { project: p, costCode: c, rowIds: [], items: 0 }
      groups.set(key, g)
    }
    g.rowIds.push(row.id)
    if (!flat && parents.has(row.id)) g.items++
  }
  const list = [...groups.values()].map((g) => ({ ...g, items: flat ? 1 : Math.max(1, g.items) }))
  const projects: CommittedRequest['projects'] = []
  for (const g of list) {
    const entry = projects.find((p) => p.code === g.project)
    if (entry) entry.costCodes.push(g.costCode)
    else projects.push({ code: g.project, costCodes: [g.costCode] })
  }
  return { request: { projects }, groups: list }
}

export interface SyncSummary {
  /** Plan items whose values were written. */
  items: number
  /** Cost codes the project does not have in Procore. */
  notFound: { project: string; costCode: string }[]
  notInProcore: string[]
  projectsNotFound: string[]
  /** Project + cost codes shared by several items: they all show the same total. */
  shared: { project: string; costCode: string; items: number }[]
}

/**
 * Writes Committed (Procore) and Awarded on the rows of every synced project, adding the columns the
 * first time (after Delivery site, else before Basis). Rows of projects that were not synced are left as
 * they are; nothing is added when no project was synced.
 */
export function applySync(store: StoreApi<SheetState>, plan: SyncPlan, response: CommittedResponse): SyncSummary {
  const byCode = new Map(response.projects.map((p) => [p.code, p]))
  const summary: SyncSummary = {
    items: 0,
    notFound: [],
    notInProcore: response.projects.filter((p) => p.status === 'not-in-procore').map((p) => p.code),
    projectsNotFound: response.projects.filter((p) => p.status === 'not-found').map((p) => p.code),
    shared: [],
  }
  const writes: { rowIds: string[]; committed: number; awarded: boolean }[] = []
  for (const g of plan.groups) {
    const result = byCode.get(g.project)
    if (!result || result.status !== 'ok') continue
    const cc = result.costCodes.find((c) => c.code === g.costCode)
    if (!cc) continue
    writes.push({ rowIds: g.rowIds, committed: cc.committed, awarded: cc.awarded })
    summary.items += g.items
    if (!cc.known) summary.notFound.push({ project: g.project, costCode: g.costCode })
    if (g.items > 1) summary.shared.push({ project: g.project, costCode: g.costCode, items: g.items })
  }
  if (writes.length === 0) return summary

  const state = store.getState()
  state.batch(() => {
    const data = store.getState().data!
    let committedId = byTitle(data, COMMITTED_COLUMN_TITLE)?.id
    let awardedId = byTitle(data, AWARDED_COLUMN_TITLE)?.id
    if (!committedId) {
      const site = byTitle(data, DELIVERY_SITE_COLUMN_TITLE)
      const basisIndex = data.columns.findIndex((c) => c === byTitle(data, BASIS_COLUMN_TITLE))
      const anchor = site?.id ?? (basisIndex > 0 ? data.columns[basisIndex - 1].id : data.columns.at(-1)?.id)
      const added = state.addColumn(COMMITTED_COLUMN_TITLE, 'TEXT_NUMBER', undefined, anchor)
      if (!added.ok) throw new Error(added.error)
      committedId = (added as { id: string }).id
    }
    if (!awardedId) {
      const added = state.addColumn(AWARDED_COLUMN_TITLE, 'PICKLIST', ['Yes', 'No'], committedId)
      if (!added.ok) throw new Error(added.error)
      awardedId = (added as { id: string }).id
    }
    for (const w of writes) {
      for (const rowId of w.rowIds) {
        state.setCell(rowId, committedId, String(w.committed))
        state.setCell(rowId, awardedId, w.awarded ? 'Yes' : 'No')
      }
    }
  })
  return summary
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function listed(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** The result line shown beside the button, e.g. "Last synced 14:05 · 6 items updated · …". */
export function syncResultText(summary: SyncSummary, at: Date): string {
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const parts = [`Last synced ${time}`, `${plural(summary.items, 'item', 'items')} updated`]
  if (summary.notFound.length > 0) {
    parts.push(`${plural(summary.notFound.length, 'cost code', 'cost codes')} not found in Procore (${summary.notFound.map((n) => `${n.costCode} on ${n.project}`).join(', ')})`)
  }
  if (summary.notInProcore.length > 0) parts.push(`${listed(summary.notInProcore)} ${summary.notInProcore.length === 1 ? 'is' : 'are'} not in Procore`)
  if (summary.projectsNotFound.length > 0) parts.push(`${listed(summary.projectsNotFound)} ${summary.projectsNotFound.length === 1 ? 'was' : 'were'} not found in Procore`)
  for (const s of summary.shared) parts.push(`${s.costCode} on ${s.project} is shared by ${s.items} items; ${s.items === 2 ? 'both' : 'all'} show the cost code total`)
  return parts.join(' · ')
}
