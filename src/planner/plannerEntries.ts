/**
 * What the preview step holds per equipment item: the drafted-and-planned item, or why it failed.
 * Pure, so the overall summary and the job/request plumbing can be tested without the UI.
 */
import type { Calendar } from '../engine/types'
import { planBackward, type BackwardPlan } from './backward'
import type { BatchPlanItem, BatchPlanRequest, PlanDraft, PlanRequest } from './types'

/** One item of a job: the request fields plus the form key it came from and its own extra notes. */
export interface JobItem extends BatchPlanItem {
  key: string
}

/** What the wizard last asked the server for: shared fields and one entry per item. */
export interface Job {
  scheduleType: string
  /** Shared notes (the form's, plus instructions given for all items). */
  notes?: string
  items: JobItem[]
}

/** 'ready': a draft with its plan (a `notice` says a later regeneration failed). 'failed': no draft. 'busy': drafting again. */
export interface Entry {
  key: string
  status: 'ready' | 'failed' | 'busy'
  request: PlanRequest
  draft?: PlanDraft
  plan?: BackwardPlan
  error?: string
  notice?: string
}

const joinNotes = (...parts: (string | undefined)[]) => parts.map((p) => p?.trim()).filter(Boolean).join('\n')

/** The single-item request the server's /draft takes for one item of the job: shared notes, then the item's own. */
export function planRequestOf(job: Job, item: JobItem): PlanRequest {
  const notes = joinNotes(job.notes, item.notes)
  return {
    scheduleType: job.scheduleType,
    equipmentType: item.equipmentType,
    equipmentName: item.equipmentName,
    requiredDate: item.requiredDate,
    ...(notes ? { notes } : {}),
  }
}

/** The body /draft-batch takes: item keys are client-side only and not sent. */
export function batchRequestOf(job: Job): BatchPlanRequest {
  return {
    scheduleType: job.scheduleType,
    ...(job.notes?.trim() ? { notes: job.notes.trim() } : {}),
    items: job.items.map(({ key: _key, notes, ...item }) => (notes?.trim() ? { ...item, notes: notes.trim() } : item)),
  }
}

/** Appends an instruction to a text of notes. */
export const appendNote = (notes: string | undefined, extra: string) => joinNotes(notes, extra) || undefined

/** Plans a draft backward to its date; throws a readable error when the engine cannot. */
export function readyEntry(key: string, request: PlanRequest, draft: PlanDraft, calendar: Calendar, today: string): Entry {
  let plan: BackwardPlan
  try {
    plan = planBackward(draft, calendar, today)
  } catch (err) {
    throw new Error(`The draft could not be scheduled: ${err instanceof Error ? err.message : 'invalid plan'}`)
  }
  return { key, status: 'ready', request, draft, plan }
}

export interface Overview {
  items: number
  ready: number
  failed: number
  /** The earliest "must start by" over the items that have a plan; null when none has. */
  earliestStart: string | null
  late: number
  sampleItems: number
  noHistoryItems: number
  /** "3 items · earliest required start 2027-01-12 · 1 item already late" */
  text: string
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function overview(entries: Entry[]): Overview {
  const planned = entries.filter((e) => e.plan && e.draft)
  const failed = entries.filter((e) => e.status === 'failed').length
  const earliestStart = planned.reduce<string | null>((min, e) => (min === null || e.plan!.mustStartBy < min ? e.plan!.mustStartBy : min), null)
  const late = planned.filter((e) => !e.plan!.feasibility.feasible).length
  const parts = [plural(entries.length, 'item')]
  if (earliestStart) parts.push(`earliest required start ${earliestStart}`)
  parts.push(late > 0 ? `${plural(late, 'item')} already late` : planned.length > 0 ? 'no item late' : '')
  if (failed > 0) parts.push(`${plural(failed, 'item')} failed`)
  return {
    items: entries.length,
    ready: planned.length,
    failed,
    earliestStart,
    late,
    sampleItems: planned.filter((e) => e.draft!.history.sampleOnly).length,
    noHistoryItems: planned.filter((e) => e.draft!.history.projectCount === 0).length,
    text: parts.filter(Boolean).join(' · '),
  }
}
