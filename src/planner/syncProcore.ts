/**
 * The sheet side of the Procore sync (docs/superpowers/specs/2026-11-22-procore-sync-design.md): which
 * rows carry a project and a cost code, and writing the committed totals back as two columns in one
 * store batch. Pure apart from the store calls in applySync.
 */
import type { StoreApi } from 'zustand/vanilla'
import type { Column } from '../model/validate'
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
  /** Rows the sheet refused to write (e.g. locked by an automation); their items are not counted as updated. */
  failedRows: number
  /** Rows whose project or cost code changed (or that were deleted) while the sync ran; left as they are. */
  changedRows: number
}

/** A sync the sheet cannot take, with a reason fit to show; nothing has been written. */
export class SyncError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncError'
  }
}

/** The server's limits (server/procoreSync.ts): checked here so one stray cell gets a clear reason, not a refusal. */
const MAX_PROJECTS = 5
const MAX_COST_CODES = 50
const MAX_CODE_CHARS = 20

/** Why the plan cannot be sent, or null when it can. */
export function checkSyncLimits(plan: SyncPlan): string | null {
  for (const p of plan.request.projects) {
    if (p.code.length > MAX_CODE_CHARS) return `The project "${p.code}" is longer than ${MAX_CODE_CHARS} characters; fix it and sync again.`
    const long = p.costCodes.find((c) => c.length > MAX_CODE_CHARS)
    if (long) return `The cost code "${long}" is longer than ${MAX_CODE_CHARS} characters; fix it and sync again.`
  }
  if (plan.request.projects.length > MAX_PROJECTS) return `This sheet has ${plan.request.projects.length} projects; a sync takes up to ${MAX_PROJECTS}.`
  const codes = plan.request.projects.reduce((n, p) => n + p.costCodes.length, 0)
  if (codes > MAX_COST_CODES) return `This sheet has ${codes} cost codes; a sync takes up to ${MAX_COST_CODES}.`
  return null
}

const plainText = (c: Column) => c.type === 'TEXT_NUMBER' && !c.role && !c.formula
const cannotHold = (title: string, what: string) => new SyncError(`The "${title}" column can’t hold ${what}. Change its type to Text/Number, or rename it so the sync adds its own.`)

/** The text written for Yes and No in an existing Awarded column, or null when it cannot hold them. */
function awardedValues(col: Column): { yes: string; no: string } | null {
  if (plainText(col)) return { yes: 'Yes', no: 'No' }
  if (col.type === 'CHECKBOX' && !col.formula) return { yes: 'true', no: 'false' }
  if (col.type === 'PICKLIST' && !col.formula) {
    const yes = col.options?.find((o) => o.trim().toLowerCase() === 'yes')
    const no = col.options?.find((o) => o.trim().toLowerCase() === 'no')
    if (yes && no) return { yes, no }
  }
  return null
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
    failedRows: 0,
    changedRows: 0,
  }
  const writes: { project: string; costCode: string; rowIds: string[]; committed: number; awarded: boolean; items: number }[] = []
  for (const g of plan.groups) {
    const result = byCode.get(g.project)
    if (!result || result.status !== 'ok') continue
    const cc = result.costCodes.find((c) => c.code === g.costCode)
    if (!cc) continue
    writes.push({ project: g.project, costCode: g.costCode, rowIds: g.rowIds, committed: cc.committed, awarded: cc.awarded, items: g.items })
    if (!cc.known) summary.notFound.push({ project: g.project, costCode: g.costCode })
    if (g.items > 1) summary.shared.push({ project: g.project, costCode: g.costCode, items: g.items })
  }
  if (writes.length === 0) return summary

  // Check the columns the sync would reuse before writing anything.
  const before = store.getState().data!
  const existingCommitted = byTitle(before, COMMITTED_COLUMN_TITLE)
  const existingAwarded = byTitle(before, AWARDED_COLUMN_TITLE)
  if (existingCommitted && !plainText(existingCommitted)) throw cannotHold(existingCommitted.title, 'amounts')
  let values = { yes: 'Yes', no: 'No' }
  if (existingAwarded) {
    const found = awardedValues(existingAwarded)
    if (!found) throw cannotHold(existingAwarded.title, 'Yes/No')
    values = found
  }

  const state = store.getState()
  state.batch(() => {
    const data = store.getState().data!
    const site = byTitle(data, DELIVERY_SITE_COLUMN_TITLE)
    const basisIndex = data.columns.findIndex((c) => c === byTitle(data, BASIS_COLUMN_TITLE))
    // Where new sync columns go: after Delivery site, else just before Basis, else at the end.
    const anchor = site?.id ?? (basisIndex > 0 ? data.columns[basisIndex - 1].id : data.columns.at(-1)?.id)
    let committedId = existingCommitted?.id
    let awardedId = existingAwarded?.id
    let awardedAnchor = anchor
    if (!committedId) {
      const added = state.addColumn(COMMITTED_COLUMN_TITLE, 'TEXT_NUMBER', undefined, anchor)
      if (!added.ok) throw new SyncError(added.error)
      committedId = (added as { id: string }).id
      awardedAnchor = committedId
    }
    if (!awardedId) {
      const added = state.addColumn(AWARDED_COLUMN_TITLE, 'PICKLIST', ['Yes', 'No'], awardedAnchor)
      if (!added.ok) throw new SyncError(added.error)
      awardedId = (added as { id: string }).id
    }

    // A row edited or deleted while Procore was answering no longer belongs to the pair asked about.
    const now = store.getState().data!
    const projectCol = projectColumn(now)
    const costCol = byTitle(now, COST_CODE_COLUMN_TITLE)
    const rows = new Map(now.rows.map((r) => [r.id, r]))
    const stillTagged = (rowId: string, project: string, costCode: string) => {
      const row = rows.get(rowId)
      return Boolean(row && projectCol && costCol && codeOf(row.cells[projectCol.id]) === project && codeOf(row.cells[costCol.id]).toUpperCase() === costCode)
    }

    for (const w of writes) {
      let failed = 0
      let changed = 0
      for (const rowId of w.rowIds) {
        if (!stillTagged(rowId, w.project, w.costCode)) {
          changed++
          continue
        }
        const a = state.setCell(rowId, committedId, String(w.committed))
        const b = state.setCell(rowId, awardedId, w.awarded ? values.yes : values.no)
        if (!a.ok || !b.ok) failed++
      }
      summary.failedRows += failed
      summary.changedRows += changed
      if (failed === 0 && changed < w.rowIds.length) summary.items += w.items
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
  if (summary.failedRows > 0) parts.push(`${plural(summary.failedRows, 'row', 'rows')} could not be updated`)
  if (summary.changedRows > 0) {
    parts.push(`${plural(summary.changedRows, 'row', 'rows')} changed during the sync and ${summary.changedRows === 1 ? 'was' : 'were'} left as ${summary.changedRows === 1 ? 'it is' : 'they are'}`)
  }
  for (const s of summary.shared) parts.push(`${s.costCode} on ${s.project} is shared by ${s.items} items; ${s.items === 2 ? 'both' : 'all'} show the cost code total`)
  return parts.join(' · ')
}
