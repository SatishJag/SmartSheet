/**
 * Checks a proposed plan (the AI's `propose_plan` tool input, or the history-only draft) against
 * the activity catalog and the duration statistics. Pure; no I/O. The server only returns plans
 * that pass, so the client can trust codes, durations and logic.
 */
import type { DepType } from '../engine/types'
import type { ActivityStats, CatalogActivity, DraftActivity, DraftLink, DurationBasis, PlanDraft } from './types'

/** The part of a PlanDraft the drafter (AI or history) produces. */
export type ProposedPlan = Pick<PlanDraft, 'activities' | 'links' | 'targetCode' | 'summary' | 'assumptions' | 'risks'>

export type ValidationResult = { ok: true; plan: ProposedPlan } | { ok: false; errors: string[] }

export interface ValidationContext {
  catalog: CatalogActivity[]
  stats: ActivityStats[]
}

export const MAX_DURATION_DAYS = 520
export const MAX_LAG_DAYS = 520
export const MAX_SUMMARY_CHARS = 2000
export const MAX_REASON_CHARS = 400
export const MAX_NOTE_CHARS = 500
export const MAX_NOTES = 15
export const MAX_LINKS = 400
const MAX_ERRORS = 40

const BASES: readonly DurationBasis[] = ['p50', 'p80', 'default', 'adjusted']
const DEP_TYPES: readonly DepType[] = ['FS', 'SS', 'FF', 'SF']

/** An activity whose catalog default is 0 days is a milestone: it takes 0 days and only 0 days. */
export function isMilestone(a: CatalogActivity): boolean {
  return a.defaultDays === 0
}

/** The catalog's target activity, or null unless exactly one is marked. */
export function catalogTarget(catalog: CatalogActivity[]): CatalogActivity | null {
  const targets = catalog.filter((a) => a.isTarget)
  return targets.length === 1 ? targets[0] : null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

export function validateDraft(input: unknown, ctx: ValidationContext): ValidationResult {
  const errors: string[] = []
  const fail = (msg: string) => {
    if (errors.length < MAX_ERRORS) errors.push(msg)
  }

  const target = catalogTarget(ctx.catalog)
  if (!target) return { ok: false, errors: ['The activity catalog must mark exactly one target activity.'] }
  if (!isObject(input)) return { ok: false, errors: ['The plan must be an object.'] }

  const catalogByCode = new Map(ctx.catalog.map((a) => [a.code, a]))
  const statsByCode = new Map(ctx.stats.filter((s) => s.n > 0).map((s) => [s.code, s]))

  // Activities.
  const activities: DraftActivity[] = []
  const seen = new Set<string>()
  if (!Array.isArray(input.activities) || input.activities.length === 0) {
    fail('activities must be a non-empty array.')
  } else {
    input.activities.forEach((raw, i) => {
      if (!isObject(raw)) return fail(`activities[${i}] must be an object.`)
      const code = typeof raw.code === 'string' ? raw.code : ''
      const label = code || `activities[${i}]`
      const cat = catalogByCode.get(code)
      if (!cat) return fail(`Activity ${label} is not in the catalog; use only catalog codes.`)
      if (seen.has(code)) return fail(`Duplicate activity code ${code}.`)
      seen.add(code)

      const d = raw.durationDays
      const basis = raw.basis as DurationBasis
      let ok = true
      if (!isInt(d) || d < 0 || d > MAX_DURATION_DAYS) {
        fail(`${code}: duration must be a whole number of working days from 0 to ${MAX_DURATION_DAYS} (got ${String(d)}).`)
        ok = false
      } else if (isMilestone(cat) && d !== 0) {
        fail(`${code} is a milestone and must take 0 days (got ${d}).`)
        ok = false
      } else if (!isMilestone(cat) && d === 0) {
        fail(`${code}: 0 days is only allowed for milestones.`)
        ok = false
      }
      if (!BASES.includes(basis)) {
        fail(`${code}: basis must be one of ${BASES.join(', ')} (got ${String(raw.basis)}).`)
        ok = false
      } else if (ok) {
        const mismatch = basisMismatch(code, d as number, basis, cat, statsByCode.get(code))
        if (mismatch) {
          fail(mismatch)
          ok = false
        }
      }
      const reason = text(raw.reason)
      if (!reason || reason.length > MAX_REASON_CHARS) {
        fail(`${code}: reason must be a non-empty sentence of at most ${MAX_REASON_CHARS} characters.`)
        ok = false
      }
      if (ok) activities.push({ code, name: cat.name, phase: cat.phase, durationDays: d as number, basis, reason: reason! })
    })
  }

  // Target.
  if (input.targetCode !== target.code) {
    fail(`targetCode must be the catalog target ${target.code} (got ${String(input.targetCode)}).`)
  } else if (!seen.has(target.code)) {
    fail(`The plan must include the target activity ${target.code}.`)
  }

  // Links.
  const links: DraftLink[] = []
  const pairs = new Set<string>()
  if (!Array.isArray(input.links)) {
    fail('links must be an array.')
  } else if (input.links.length > MAX_LINKS) {
    fail(`At most ${MAX_LINKS} links.`)
  } else {
    input.links.forEach((raw, i) => {
      if (!isObject(raw)) return fail(`links[${i}] must be an object.`)
      const { from, to, type, lagDays } = raw
      const label = `Link ${String(from)} -> ${String(to)}`
      let ok = true
      for (const code of [from, to]) {
        if (typeof code !== 'string' || !seen.has(code)) {
          const where = typeof code === 'string' && catalogByCode.has(code) ? 'not in the plan' : 'unknown'
          fail(`${label}: activity ${String(code)} is ${where}.`)
          ok = false
        }
      }
      if (ok && from === to) {
        fail(`${label}: an activity cannot depend on itself.`)
        ok = false
      }
      if (!DEP_TYPES.includes(type as DepType)) {
        fail(`${label}: type must be one of ${DEP_TYPES.join(', ')} (got ${String(type)}).`)
        ok = false
      }
      if (!isInt(lagDays) || Math.abs(lagDays) > MAX_LAG_DAYS) {
        fail(`${label}: lagDays must be a whole number between -${MAX_LAG_DAYS} and ${MAX_LAG_DAYS} (got ${String(lagDays)}).`)
        ok = false
      }
      const key = `${String(from)}\u0000${String(to)}`
      if (ok && pairs.has(key)) {
        fail(`${label}: duplicate link between the same two activities.`)
        ok = false
      }
      if (ok) {
        pairs.add(key)
        links.push({ from: from as string, to: to as string, type: type as DepType, lagDays: lagDays as number })
      }
    })
  }

  // Logic: acyclic, target last, everything leads to the target.
  if (errors.length === 0) {
    const codes = activities.map((a) => a.code)
    const cycle = findCycle(codes, links)
    if (cycle) fail(`The logic has a cycle: ${cycle.join(' -> ')}.`)
    const targetSuccessors = links.filter((l) => l.from === target.code).map((l) => l.to)
    if (targetSuccessors.length > 0) {
      fail(`The target ${target.code} must end the logic but has successor(s): ${targetSuccessors.join(', ')}.`)
    }
    const reaches = ancestorsOf(target.code, links)
    for (const code of codes) {
      if (code !== target.code && !reaches.has(code)) fail(`${code} does not lead to the target ${target.code}; link it into the logic.`)
    }
  }

  // Text.
  const summary = text(input.summary)
  if (!summary || summary.length > MAX_SUMMARY_CHARS) fail(`summary must be non-empty text of at most ${MAX_SUMMARY_CHARS} characters.`)
  const assumptions = textList(input.assumptions, 'assumptions', fail)
  const risks = textList(input.risks, 'risks', fail)

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, plan: { activities, links, targetCode: target.code, summary: summary!, assumptions, risks } }
}

function basisMismatch(
  code: string,
  days: number,
  basis: DurationBasis,
  cat: CatalogActivity,
  stats: ActivityStats | undefined,
): string | null {
  if (basis === 'adjusted') return null
  if (basis === 'default') {
    return days === cat.defaultDays ? null : `${code}: basis default means the catalog default of ${cat.defaultDays} days (got ${days}); otherwise mark it adjusted.`
  }
  if (!stats) return `${code}: basis ${basis} cites history, but there is no history for this activity; use default or adjusted.`
  const value = stats[basis]
  // Statistics may be fractional; either neighbouring whole day counts as citing them.
  return Math.abs(days - value) < 1
    ? null
    : `${code}: basis ${basis} means ${Math.round(value)} days (got ${days}); otherwise mark it adjusted.`
}

function textList(v: unknown, field: string, fail: (msg: string) => void): string[] {
  if (!Array.isArray(v) || v.length > MAX_NOTES) {
    fail(`${field} must be an array of at most ${MAX_NOTES} strings.`)
    return []
  }
  const out: string[] = []
  for (const item of v) {
    const t = text(item)
    if (!t || t.length > MAX_NOTE_CHARS) {
      fail(`${field} must contain non-empty strings of at most ${MAX_NOTE_CHARS} characters.`)
      return []
    }
    out.push(t)
  }
  return out
}

/** One cycle through the links, or null when they form a DAG (Kahn's algorithm, then a walk). */
function findCycle(codes: string[], links: DraftLink[]): string[] | null {
  const indegree = new Map(codes.map((c) => [c, 0]))
  const succ = new Map<string, string[]>(codes.map((c) => [c, []]))
  for (const l of links) {
    succ.get(l.from)!.push(l.to)
    indegree.set(l.to, indegree.get(l.to)! + 1)
  }
  const queue = codes.filter((c) => indegree.get(c) === 0)
  let removed = 0
  while (queue.length > 0) {
    const c = queue.shift()!
    removed++
    for (const s of succ.get(c)!) {
      indegree.set(s, indegree.get(s)! - 1)
      if (indegree.get(s) === 0) queue.push(s)
    }
  }
  if (removed === codes.length) return null
  // Every remaining node has a remaining predecessor; walk predecessors until one repeats.
  const remaining = new Set(codes.filter((c) => indegree.get(c)! > 0))
  const path: string[] = []
  const at = new Map<string, number>()
  let c = [...remaining][0]
  while (!at.has(c)) {
    at.set(c, path.length)
    path.push(c)
    c = links.find((l) => l.to === c && remaining.has(l.from))!.from
  }
  return [c, ...path.slice(at.get(c)!).reverse()]
}

/** Every code with a path to `code` along the links. */
function ancestorsOf(code: string, links: DraftLink[]): Set<string> {
  const preds = new Map<string, string[]>()
  for (const l of links) preds.set(l.to, [...(preds.get(l.to) ?? []), l.from])
  const out = new Set<string>()
  const stack = [code]
  while (stack.length > 0) {
    for (const p of preds.get(stack.pop()!) ?? []) {
      if (!out.has(p)) {
        out.add(p)
        stack.push(p)
      }
    }
  }
  return out
}
