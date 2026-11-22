/**
 * The server side of importing a plan from Excel (docs/superpowers/specs/2026-11-22-plan-import-design.md).
 * The browser copies the planner's rows exactly; this only judges:
 *  - mapImportColumns: maps an unknown layout's headings to fields (AI, headings + a few sample rows);
 *  - planImport: matches the schedule type, fills blank durations from the template or history, gives
 *    template links to activities the file left unlinked, and asks the AI only for durations of
 *    activities the template does not have.
 * Nothing from the request is stored.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { ImportField, TableMapping } from '../src/planner/import/table'
import type {
  CatalogActivity,
  HistorySource,
  HistorySummary,
  ImportActivitiesResult,
  ImportActivityRef,
  ImportDuration,
  ImportRequest,
  ImportTemplateLink,
} from '../src/planner/types'
import type { AnthropicLike } from './ai'
import type { Logger } from './log'
import { PlannerError } from './planner'

export const ESTIMATE_FALLBACK_DAYS = 5
const FALLBACK_REASON = 'default: no AI estimate available'
const TEMPLATE_REASON = 'from the template, no history yet'
const MAX_ACTIVITIES = 500
const MAX_COLUMN_SHEETS = 5
const MAX_SAMPLE_ROWS = 30
const MAX_COLUMNS = 60
const MAX_TEXT = 500
/** At least this share of the file's activities must be in a catalog for it to count as that template. */
const MATCH_SHARE = 0.5

export interface ImportConfig {
  anthropic: AnthropicLike | null
  model: string
  aiTimeoutMs: number
  aiDeadlineMs: number
  log: Logger
  signal?: AbortSignal
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.length <= max

/** The import request body, checked: exactly one of `columns` or `activities`, within the limits. */
export function parseImportRequest(body: unknown): Parsed<ImportRequest> {
  const bad = (error: string): Parsed<ImportRequest> => ({ ok: false, error })
  if (!isObject(body) || !isObject(body.hints)) return bad('Send hints with the file name and sheet names.')
  const { fileName, sheetNames } = body.hints
  if (!isText(fileName, 255) || !Array.isArray(sheetNames) || sheetNames.length > 50 || !sheetNames.every((n) => isText(n, 255))) {
    return bad('The hints are not valid.')
  }
  const hasColumns = body.columns !== undefined
  const hasActivities = body.activities !== undefined
  if (hasColumns === hasActivities) return bad('Send either columns or activities.')
  const value: ImportRequest = { hints: { fileName, sheetNames: sheetNames as string[] } }

  if (hasColumns) {
    const cols = body.columns
    if (!Array.isArray(cols) || cols.length === 0 || cols.length > MAX_COLUMN_SHEETS) return bad(`Send 1 to ${MAX_COLUMN_SHEETS} sheets of columns.`)
    for (const c of cols) {
      if (!isObject(c) || !isText(c.sheet, 255) || !Array.isArray(c.rows) || c.rows.length > MAX_SAMPLE_ROWS) return bad('The columns are not valid.')
      if (!c.rows.every((r) => Array.isArray(r) && r.length <= MAX_COLUMNS && r.every((x) => isText(x)))) return bad('The columns are not valid.')
    }
    value.columns = cols as ImportRequest['columns']
  } else {
    const acts = body.activities
    if (!Array.isArray(acts) || acts.length === 0 || acts.length > MAX_ACTIVITIES) return bad(`Send 1 to ${MAX_ACTIVITIES} activities.`)
    for (const a of acts) {
      if (!isObject(a) || !isText(a.code, 100) || !isText(a.name) || !isText(a.phase) || typeof a.hasDuration !== 'boolean' || typeof a.hasPredecessors !== 'boolean') {
        return bad('The activities are not valid.')
      }
    }
    value.activities = (acts as ImportActivityRef[]).map(({ code, name, phase, hasDuration, hasPredecessors }) => ({ code, name, phase, hasDuration, hasPredecessors }))
  }
  if (body.scheduleType !== undefined) {
    if (body.scheduleType !== null && !isText(body.scheduleType, 100)) return bad('The schedule type is not valid.')
    value.scheduleType = body.scheduleType as string | null
  }
  return { ok: true, value }
}

const lower = (s: string) => s.trim().toLowerCase()

/** The schedule type whose catalog covers at least half of the file's activities (by code or name); else null. */
export function matchScheduleType(catalogs: Record<string, CatalogActivity[]>, activities: readonly ImportActivityRef[]): string | null {
  let best: { type: string; hits: number } | null = null
  for (const [type, catalog] of Object.entries(catalogs)) {
    const codes = new Set(catalog.map((a) => a.code))
    const names = new Set(catalog.map((a) => lower(a.name)))
    const hits = activities.filter((a) => codes.has(a.code) || names.has(lower(a.name))).length
    if (!best || hits > best.hits) best = { type, hits }
  }
  return best && best.hits >= Math.ceil(activities.length * MATCH_SHARE) && best.hits > 0 ? best.type : null
}

/** The deterministic part of an import, and the activities still needing an AI estimate. */
export interface PreparedImport {
  value: ImportActivitiesResult
  toEstimate: ImportActivityRef[]
  scheduleTypeName: string | null
}

const empty = (type: string): HistorySummary => ({ scheduleType: type, equipmentType: null, projectCount: 0, sampleOnly: false, stats: [] })

/** Matches the type, fills template durations and links. No AI; throws PlannerError for an unknown chosen type. */
export async function prepareImport(source: HistorySource, req: ImportRequest): Promise<PreparedImport> {
  const activities = req.activities ?? []
  const options = await source.options()
  let scheduleType: string | null
  if (req.scheduleType !== undefined) {
    if (req.scheduleType !== null && !options.scheduleTypes.some((t) => t.id === req.scheduleType)) {
      throw new PlannerError(400, `Unknown schedule type: ${req.scheduleType}.`)
    }
    scheduleType = req.scheduleType
  } else {
    const catalogs: Record<string, CatalogActivity[]> = {}
    for (const t of options.scheduleTypes) catalogs[t.id] = await source.catalog(t.id)
    scheduleType = matchScheduleType(catalogs, activities)
  }

  const catalog = scheduleType ? await source.catalog(scheduleType) : []
  const history = scheduleType ? await source.summary(scheduleType, null) : null
  // A file activity is a template activity when its code matches, else its name (renumbered copies).
  const byCode = new Map(catalog.map((a) => [a.code, a]))
  const byName = new Map(catalog.map((a) => [lower(a.name), a]))
  const templateOf = (a: ImportActivityRef) => byCode.get(a.code) ?? byName.get(lower(a.name))
  const fileCodeOf = new Map<string, string>() // template code -> the file's code for it (first one)
  for (const a of activities) {
    const t = templateOf(a)
    if (t && !fileCodeOf.has(t.code)) fileCodeOf.set(t.code, a.code)
  }
  const stats = new Map((history?.stats ?? []).filter((s) => s.n > 0).map((s) => [s.code, s]))

  const durations: ImportDuration[] = []
  const toEstimate: ImportActivityRef[] = []
  const templateLinks: ImportTemplateLink[] = []
  for (const a of activities) {
    const known = templateOf(a)
    if (!a.hasDuration) {
      if (!known) toEstimate.push(a)
      else if (known.defaultDays === 0) durations.push({ code: a.code, days: 0, basis: 'template', reason: TEMPLATE_REASON })
      else {
        const s = stats.get(known.code)
        if (s && Math.round(s.p50) >= 1) {
          durations.push({ code: a.code, days: Math.round(s.p50), basis: 'history', reason: `Median (p50) of ${s.n} historical project${s.n === 1 ? '' : 's'}.` })
        } else {
          durations.push({ code: a.code, days: known.defaultDays, basis: 'template', reason: TEMPLATE_REASON })
        }
      }
    }
    if (known && !a.hasPredecessors) {
      for (const l of known.defaultLinks) {
        const from = fileCodeOf.get(l.from)
        if (from && from !== a.code) templateLinks.push({ to: a.code, from, type: l.type, lagDays: l.lagDays })
      }
    }
  }
  const target = catalog.find((a) => a.isTarget)
  return {
    value: {
      scheduleType,
      targetCode: (target && fileCodeOf.get(target.code)) ?? null,
      durations,
      templateLinks,
      history: scheduleType ? (history ?? empty(scheduleType)) : null,
    },
    toEstimate,
    scheduleTypeName: options.scheduleTypes.find((t) => t.id === scheduleType)?.name ?? null,
  }
}

type BetaMessage = Anthropic.Beta.Messages.BetaMessage
type ToolUse = Anthropic.Beta.Messages.BetaToolUseBlock

/** One forced tool call; the tool input, or null on any failure (logged). */
async function callTool(config: ImportConfig, tool: Anthropic.Beta.Messages.BetaTool, prompt: string, event: string, maxTokens = 8000): Promise<unknown> {
  if (!config.anthropic) return null
  const deadline = AbortSignal.timeout(config.aiDeadlineMs)
  const signal = config.signal ? AbortSignal.any([deadline, config.signal]) : deadline
  let res: BetaMessage
  try {
    res = await config.anthropic.beta.messages.create(
      {
        model: config.model,
        max_tokens: maxTokens,
        system: 'You help import construction schedules from spreadsheets. Answer only through the tool.',
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: prompt }],
      },
      { timeout: config.aiTimeoutMs, maxRetries: 1, signal },
    )
  } catch (err) {
    config.log(`${event}.error`, { message: (err as Error).message.slice(0, 200) })
    return null
  }
  config.log(`${event}.response`, { stop: res.stop_reason, usage: res.usage })
  const call = res.content.find((b): b is ToolUse => b.type === 'tool_use' && b.name === tool.name)
  return call ? call.input : null
}

const ESTIMATE_TOOL: Anthropic.Beta.Messages.BetaTool = {
  name: 'estimate_durations',
  description: 'Give a duration estimate in working days for each listed activity.',
  input_schema: {
    type: 'object',
    properties: {
      estimates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            days: { type: 'integer', minimum: 1 },
            reason: { type: 'string', description: 'One short sentence: why this duration.' },
          },
          required: ['code', 'days', 'reason'],
        },
      },
    },
    required: ['estimates'],
  },
}

/** Longest believable estimate (about eight working years); anything above falls back. */
const MAX_ESTIMATE_DAYS = 2000

/** The AI's usable estimates by code: whole days from 1 to 2000; codes missing or invalid are left out. */
async function estimateDurations(config: ImportConfig, acts: ImportActivityRef[], scheduleTypeName: string | null): Promise<Map<string, { days: number; reason: string }> | null> {
  const prompt = [
    `A planner imported a ${scheduleTypeName ?? 'construction'} schedule. These activities have no duration in the file.`,
    'Estimate each one in working days, as a typical project of this kind would need. Keep each reason to one short sentence.',
    '',
    ...acts.map((a) => `- ${a.code}: ${a.name}${a.phase ? ` (stage: ${a.phase})` : ''}`),
  ].join('\n')
  // About 40 output tokens per estimate, with room to spare: long lists are not cut off.
  const input = await callTool(config, ESTIMATE_TOOL, prompt, 'planner.import.estimate', Math.min(32000, 2000 + acts.length * 60))
  if (!isObject(input) || !Array.isArray(input.estimates)) return null
  const wanted = new Set(acts.map((a) => a.code))
  const out = new Map<string, { days: number; reason: string }>()
  for (const e of input.estimates) {
    if (!isObject(e) || typeof e.code !== 'string' || !wanted.has(e.code) || out.has(e.code)) continue
    const days = e.days
    if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > MAX_ESTIMATE_DAYS || typeof e.reason !== 'string') continue
    out.set(e.code, { days: days as number, reason: e.reason.slice(0, 300) })
  }
  return out
}

/** Adds the AI estimates (or the 5-day fallback) to a prepared import. */
export async function completeImport(prep: PreparedImport, config: ImportConfig): Promise<{ value: ImportActivitiesResult; usedAi: boolean }> {
  if (prep.toEstimate.length === 0) return { value: prep.value, usedAi: false }
  const usedAi = config.anthropic !== null
  const estimates = usedAi ? await estimateDurations(config, prep.toEstimate, prep.scheduleTypeName) : null
  const filled: ImportDuration[] = prep.toEstimate.map((a) => {
    const e = estimates?.get(a.code)
    return e ? { code: a.code, days: e.days, basis: 'estimate', reason: e.reason } : { code: a.code, days: ESTIMATE_FALLBACK_DAYS, basis: 'estimate', reason: FALLBACK_REASON }
  })
  return { value: { ...prep.value, durations: [...prep.value.durations, ...filled] }, usedAi }
}

/** prepareImport then completeImport (the route acquires its slot in between). */
export async function planImport(source: HistorySource, req: ImportRequest, config: ImportConfig): Promise<{ value: ImportActivitiesResult; usedAi: boolean }> {
  return completeImport(await prepareImport(source, req), config)
}

const FIELDS: ImportField[] = ['activityId', 'name', 'phase', 'kind', 'responsibility', 'duration', 'start', 'finish', 'status', 'predecessors', 'criteria']

const MAP_TOOL: Anthropic.Beta.Messages.BetaTool = {
  name: 'map_columns',
  description: 'Say which sheet holds the list of schedule activities, which row has its headings, and which column holds each field.',
  input_schema: {
    type: 'object',
    properties: {
      found: { type: 'boolean', description: 'False when no sheet has a list of activities.' },
      sheet: { type: 'string' },
      headingRow: { type: 'integer', minimum: 0, description: '0-based row index of the headings in that sheet.' },
      fields: {
        type: 'object',
        description: '0-based column index per field; leave out fields the table does not have. `name` is required.',
        properties: Object.fromEntries(FIELDS.map((f) => [f, { type: 'integer', minimum: 0 }])),
      },
    },
    required: ['found'],
  },
}

/** The AI's mapping of an unknown layout, checked against what was sent; null when none or invalid. */
export async function mapImportColumns(req: ImportRequest, config: ImportConfig): Promise<{ mapping: TableMapping | null; usedAi: boolean }> {
  if (!config.anthropic) return { mapping: null, usedAi: false }
  const sheets = req.columns ?? []
  const prompt = [
    'These are the first rows of each sheet of an uploaded construction schedule. Find the list of activities (tasks/milestones).',
    `Fields: ${FIELDS.join(', ')} (activityId = the activity's code; name = its description; phase = stage or WBS; kind = activity or milestone).`,
    '',
    ...sheets.map((s) => `Sheet "${s.sheet}":\n${s.rows.map((r, i) => `${i}: ${r.map((c) => c.slice(0, 80)).join(' | ')}`).join('\n')}`),
  ].join('\n')
  const input = await callTool(config, MAP_TOOL, prompt, 'planner.import.map')
  if (!isObject(input) || input.found !== true || typeof input.sheet !== 'string' || !Number.isInteger(input.headingRow) || !isObject(input.fields)) {
    return { mapping: null, usedAi: true }
  }
  const sheet = sheets.find((s) => s.sheet === input.sheet)
  const headingRow = input.headingRow as number
  if (!sheet || headingRow >= sheet.rows.length) return { mapping: null, usedAi: true }
  const width = Math.max(...sheet.rows.map((r) => r.length))
  const fields: TableMapping['fields'] = {}
  for (const f of FIELDS) {
    const v = input.fields[f]
    if (v === undefined) continue
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= width) return { mapping: null, usedAi: true }
    fields[f] = v as number
  }
  if (fields.name === undefined) return { mapping: null, usedAi: true }
  return { mapping: { sheet: sheet.sheet, headingRow, fields }, usedAi: true }
}
