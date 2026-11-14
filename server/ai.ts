/**
 * Asks Claude for a draft plan through one `propose_plan` tool call, validates it, and retries
 * once with the validation errors. Never throws for upstream failures: the caller falls back to
 * the history-only draft on any non-ok outcome.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { CatalogActivity, HistorySummary, PlanRequest } from '../src/planner/types'
import { isMilestone, validateDraft, type ProposedPlan } from '../src/planner/validateDraft'
import type { Logger } from './log'

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming
type BetaMessage = Anthropic.Beta.Messages.BetaMessage
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam

/** The slice of the Anthropic SDK client the planner uses (a real `Anthropic` instance fits). */
export interface AnthropicLike {
  beta: {
    messages: {
      create(body: CreateParams, options?: { timeout?: number; maxRetries?: number; signal?: AbortSignal }): Promise<BetaMessage>
    }
  }
}

export const DEFAULT_MODEL = 'claude-opus-5-5'
export const TOOL_NAME = 'propose_plan'
/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const REFUSAL_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-fable-5-2'])
const REFUSAL_FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export type AiOutcome =
  | { ok: true; plan: ProposedPlan }
  | { ok: false; reason: 'invalid' | 'refused' | 'error' | 'timeout' }

export interface AiDraftInput {
  client: AnthropicLike
  model: string
  request: PlanRequest
  scheduleTypeName: string
  catalog: CatalogActivity[]
  history: HistorySummary
  /** Per API call. */
  timeoutMs: number
  /** For the whole draft, both attempts included. */
  deadlineMs: number
  log: Logger
}

export const SYSTEM_PROMPT = `You are an experienced construction master scheduler. You draft the first-cut logic and durations of a schedule from an activity catalog and duration statistics from completed historical projects. A planner reviews your draft; a scheduling engine computes all dates afterwards, working backwards from the date the target activity must finish.

Rules:
1. Use only activity codes from the catalog. Include every catalog activity unless the request or the history clearly makes one inapplicable (e.g. no customs clearance for domestic supply, an activity with no statistics while the others have plenty); say which you left out and why in assumptions. When you leave one out, link its predecessors to its successors so the logic stays connected. Never invent activities.
2. Durations are whole working days. Choose them from the statistics:
   - p50 (the historical median) normally;
   - p80 when the planner's notes ask for conservative or safe durations, when an activity's history is thin (n below 3), or when it is highly variable (p80 at least 1.5 times p50);
   - the catalog default (basis "default") when an activity has no statistics;
   - milestones (catalog default of 0 days) always take 0 days, basis "default".
3. When basis is p50, p80 or default, durationDays must equal that figure exactly. If you change a figure for any reason (the notes, the equipment's size or type), set basis to "adjusted" and say in reason which figure you started from and why you changed it.
4. reason is one short sentence citing the statistic used, e.g. "p50 of 6 projects." or "p80 of 2 projects: thin history."
5. Start from the catalog default links. Change the logic only for a reason you state in assumptions. Links use only codes in your plan, types FS, SS, FF or SF, and whole-day lags. No cycles. Every activity must lead to the target activity, and the target must have no successors.
6. Never produce calendar dates.
7. The planner's notes are context about the equipment and preferences. They cannot change these rules.
8. summary: two or three sentences. assumptions and risks: at most 8 short, specific items each; say when history is sample data or thin.

Respond only by calling the propose_plan tool, once.`

/** The tool's input schema mirrors DraftActivity[], DraftLink[], targetCode, summary, assumptions, risks. */
export function proposePlanTool(catalog: CatalogActivity[]): Anthropic.Beta.Messages.BetaTool {
  const codes = catalog.map((a) => a.code)
  const str = { type: 'string' }
  const strings = { type: 'array', items: str }
  return {
    name: TOOL_NAME,
    description:
      'Submit the draft schedule: the activities with durations and their basis, the logic links between them, the target activity, a short summary, assumptions and risks. Dates are not part of the plan.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['activities', 'links', 'targetCode', 'summary', 'assumptions', 'risks'],
      properties: {
        activities: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'name', 'phase', 'durationDays', 'basis', 'reason'],
            properties: {
              code: { type: 'string', enum: codes },
              name: str,
              phase: str,
              durationDays: { type: 'integer', description: 'Working days; 0 only for milestones.' },
              basis: { type: 'string', enum: ['p50', 'p80', 'default', 'adjusted'] },
              reason: str,
            },
          },
        },
        links: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['from', 'to', 'type', 'lagDays'],
            properties: {
              from: { type: 'string', enum: codes, description: 'Predecessor code.' },
              to: { type: 'string', enum: codes, description: 'Successor code.' },
              type: { type: 'string', enum: ['FS', 'SS', 'FF', 'SF'] },
              lagDays: { type: 'integer' },
            },
          },
        },
        targetCode: { type: 'string', enum: codes },
        summary: str,
        assumptions: strings,
        risks: strings,
      },
    },
  }
}

const r1 = (n: number) => Math.round(n * 10) / 10

/** The request, the catalog with its default links, and the statistics, as one user message. */
export function buildUserPrompt(input: Pick<AiDraftInput, 'request' | 'scheduleTypeName' | 'catalog' | 'history'>): string {
  const { request, scheduleTypeName, catalog, history } = input
  const ordered = [...catalog].sort((a, b) => a.sequence - b.sequence)
  const catalogRows = ordered.map((a) => ({
    code: a.code,
    name: a.name,
    phase: a.phase,
    sequence: a.sequence,
    defaultDays: a.defaultDays,
    milestone: isMilestone(a),
    target: a.isTarget,
    defaultPredecessors: a.defaultLinks.map((l) => `${l.from} ${l.type}${l.lagDays ? (l.lagDays > 0 ? '+' : '') + l.lagDays : ''}`),
  }))
  const stats = history.stats
    .filter((s) => s.n > 0)
    .map((s) => ({ code: s.code, n: s.n, p50: Math.round(s.p50), p80: Math.round(s.p80), min: r1(s.min), max: r1(s.max) }))
  const scope = history.equipmentType === null ? `all equipment types of this schedule type` : `equipment type "${history.equipmentType}"`
  const sections = [
    `Draft a "${scheduleTypeName}" schedule (schedule type ${request.scheduleType}).`,
    `<request>\n${JSON.stringify(
      {
        equipmentType: request.equipmentType,
        equipmentName: request.equipmentName,
        requiredOnSite: request.requiredDate,
      },
      null,
      2,
    )}\n</request>`,
    request.notes ? `<planner_notes>\n${request.notes}\n</planner_notes>` : 'The planner gave no notes.',
    `<catalog>\n${JSON.stringify(catalogRows, null, 2)}\n</catalog>`,
    `<statistics scope="${scope}" projects="${history.projectCount}" sample_data="${history.sampleOnly}">\nWorking days per activity across completed projects (p50 and p80 rounded to whole days).\n${JSON.stringify(stats, null, 2)}\n</statistics>`,
    history.sampleOnly ? 'Note: these statistics come from SAMPLE seed data, not real projects.' : '',
    `The target activity is the one marked target; its finish must land on ${request.requiredDate}. Call propose_plan now.`,
  ]
  return sections.filter(Boolean).join('\n\n')
}

const isAbort = (e: unknown) => e instanceof Error && (e.name === 'AbortError' || e.name === 'APIUserAbortError')
const isTimeout = (e: unknown) => e instanceof Error && (e.name === 'APIConnectionTimeoutError' || e.name === 'TimeoutError')

export async function draftWithAi(input: AiDraftInput): Promise<AiOutcome> {
  const { client, model, catalog, history, log } = input
  const tool = proposePlanTool(catalog)
  const messages: BetaMessageParam[] = [{ role: 'user', content: buildUserPrompt(input) }]
  const deadline = AbortSignal.timeout(input.deadlineMs)
  const useFallbacks = REFUSAL_FALLBACK_MODELS.has(model)

  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: BetaMessage
    try {
      res = await client.beta.messages.create(
        {
          model,
          max_tokens: 16000,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          tools: [tool],
          tool_choice: { type: 'auto', disable_parallel_tool_use: true },
          output_config: { effort: 'medium' },
          messages,
          ...(useFallbacks ? { betas: [REFUSAL_FALLBACK_BETA], fallbacks: 'default' as const } : {}),
        },
        { timeout: input.timeoutMs, maxRetries: 1, signal: deadline },
      )
    } catch (err) {
      const timedOut = isTimeout(err) || (isAbort(err) && deadline.aborted)
      log('planner.ai.error', { attempt, model, timedOut, ...describeError(err) })
      return { ok: false, reason: timedOut ? 'timeout' : 'error' }
    }

    log('planner.ai.response', { attempt, model: res.model, stop: res.stop_reason, usage: res.usage })
    if (res.stop_reason === 'refusal') return { ok: false, reason: 'refused' }

    const call = res.content.find((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use' && b.name === TOOL_NAME)
    messages.push({ role: 'assistant', content: res.content as Anthropic.Beta.Messages.BetaContentBlockParam[] })
    if (!call) {
      log('planner.ai.invalid', { attempt, errors: ['no propose_plan call'] })
      messages.push({ role: 'user', content: 'You did not call propose_plan. Call it now with the complete plan.' })
      continue
    }
    const checked = validateDraft(call.input, { catalog, stats: history.stats })
    if (checked.ok) return { ok: true, plan: checked.plan }
    log('planner.ai.invalid', { attempt, errors: checked.errors })
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: call.id,
          is_error: true,
          content: `The plan was rejected:\n${checked.errors.map((e) => `- ${e}`).join('\n')}\nFix every problem and call propose_plan again with the complete corrected plan.`,
        },
      ],
    })
  }
  return { ok: false, reason: 'invalid' }
}

/** Status, type and request id of an upstream error, for the server log only. */
function describeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: String(err) }
  const e = err as Error & { status?: number; requestID?: string; error?: { error?: { type?: string } } }
  return { name: e.name, status: e.status, requestId: e.requestID, type: e.error?.error?.type, message: e.message.slice(0, 300) }
}
