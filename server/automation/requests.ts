/**
 * Update requests and approvals: creating them (a token per recipient, e-mailed as a link) and
 * answering them (the public endpoints). Used by the authenticated endpoint, by rules that run on the
 * server, and by the public routes, so the rules about who may change what live in one place.
 */
import type { Logger } from '../log'
import { isEmail } from '../../src/automation/values'
import type { AutomationConfig } from './config'
import type { Outbound } from './outbound'
import { fieldsFor, requestableProblem, validateResponse } from './respond'
import type { AutomationStore, RequestRecord, SheetBundle } from './store'
import { generateToken, hashToken } from './tokens'
import { formatValue } from '../../src/automation/values'
import { isFormulaCell } from './formulas'

export const MAX_RECIPIENTS = 10
const DAY_MS = 86_400_000

export interface CreateInput {
  kind: 'update' | 'approval'
  ruleId: string | null
  rowId: string
  emails: string[]
  message: string
  expiresInDays: number
  columnIds?: string[]
  approval?: { statusColumnId: string; pendingValue: string | null; approvedValue: string; declinedValue: string; showColumnIds: string[] }
}

export type CreateResult =
  | { ok: true; items: { id: string; email: string; path: string; url: string | null; mail: 'sent' | 'simulated' | 'skipped' | 'failed' }[] }
  | { ok: false; status: number; error: string }

const fail = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error })

export type AnswerResult =
  | { ok: true }
  | { ok: false; status: number; error: string; fieldId?: string; state?: string }

export interface RequestService {
  create(bundle: SheetBundle, input: CreateInput): Promise<CreateResult>
  /** What the public page shows for a request (only the requested columns). */
  view(rec: RequestRecord, bundle: SheetBundle): Promise<unknown>
  answerUpdate(rec: RequestRecord, bundle: SheetBundle, values: unknown): Promise<AnswerResult>
  answerApproval(rec: RequestRecord, bundle: SheetBundle, decision: unknown, comment: unknown): Promise<AnswerResult>
}

export function createRequestService(deps: { store: AutomationStore; outbound: Outbound; config: Pick<AutomationConfig, 'publicUrl'>; now: () => number; log: Logger }): RequestService {
  const { store, outbound, config, now, log } = deps

  async function ownerNote(rec: RequestRecord, title: string, body: string) {
    await store
      .createNotifications(rec.ownerId, [
        { channel: 'app', kind: rec.kind === 'update' ? 'update_request' : 'approval', sheetId: rec.sheetId, rowId: rec.rowId, ruleId: rec.ruleId, recipientEmail: null, title: title.slice(0, 200), body: body.slice(0, 4800), payload: {}, frequency: 'immediately', deliverAfter: now() },
      ])
      .catch((err) => log('automation.notify.failed', { error: (err as Error).message }))
  }

  return {
    async create(bundle, input) {
      const row = bundle.rows.find((r) => r.id === input.rowId)
      if (!row) return fail(404, 'That row was not found.')
      const emails = [...new Set(input.emails.map((e) => e.trim().toLowerCase()))].filter(Boolean)
      if (emails.length === 0) return fail(400, 'Add at least one e-mail address.')
      if (emails.length > MAX_RECIPIENTS) return fail(400, `At most ${MAX_RECIPIENTS} recipients per request.`)
      const bad = emails.find((e) => !isEmail(e) || e.length > 320)
      if (bad) return fail(400, `"${bad.slice(0, 60)}" is not a valid e-mail address.`)
      if (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > 90) return fail(400, 'Choose between 1 and 90 days.')
      if (input.message.length > 2000) return fail(400, 'The message must be at most 2000 characters.')
      const ctx = { dependenciesEnabled: bundle.dependenciesEnabled, rowHasChildren: bundle.rows.some((r) => r.parentId === row.id) }

      let columnIds: string[] = []
      let approval: NonNullable<CreateInput['approval']> | null = null
      if (input.kind === 'update') {
        columnIds = [...new Set(input.columnIds ?? [])]
        if (columnIds.length === 0 || columnIds.length > 20) return fail(400, 'Choose between 1 and 20 columns to update.')
        for (const id of columnIds) {
          const col = bundle.columns.find((c) => c.id === id)
          if (!col) return fail(400, 'One of the columns no longer exists.')
          const problem = requestableProblem(col, ctx)
          if (problem) return fail(400, problem)
        }
      } else {
        approval = input.approval ?? null
        if (!approval) return fail(400, 'The approval settings are missing.')
        const status = bundle.columns.find((c) => c.id === approval!.statusColumnId)
        if (!status) return fail(400, 'The column for the answer no longer exists.')
        const problem = requestableProblem(status, ctx)
        if (problem) return fail(400, problem)
        const { approvedValue, declinedValue, pendingValue } = approval
        for (const v of [approvedValue, declinedValue]) if (!v || v.length > 200) return fail(400, 'The approve and decline values must be 1 to 200 characters.')
        if (approvedValue.trim().toLowerCase() === declinedValue.trim().toLowerCase()) return fail(400, 'The approve and decline values must differ.')
        if (status.type === 'PICKLIST') {
          const options = status.options ?? []
          for (const v of [approvedValue, declinedValue, ...(pendingValue ? [pendingValue] : [])]) {
            if (!options.includes(v)) return fail(400, `"${v}" is not an option of "${status.title}".`)
          }
        }
        for (const id of approval.showColumnIds) if (!bundle.columns.some((c) => c.id === id)) return fail(400, 'One of the columns to show no longer exists.')
      }
      if ((await store.lockedRows(bundle.id)).has(row.id)) return fail(423, 'This row is locked.')

      const items: Extract<CreateResult, { ok: true }>['items'] = []
      const expiresAt = now() + input.expiresInDays * DAY_MS
      const owner = await store.owner(bundle.ownerId)
      for (const email of emails) {
        const token = generateToken()
        const id = await store.insertRequest({
          kind: input.kind,
          tokenHash: hashToken(token),
          sheetId: bundle.id,
          rowId: row.id,
          ownerId: bundle.ownerId,
          workspaceId: bundle.workspaceId,
          ruleId: input.ruleId,
          email,
          expiresAt,
          message: input.message,
          columnIds,
          ...(approval ? { approval: { statusColumnId: approval.statusColumnId, approvedValue: approval.approvedValue, declinedValue: approval.declinedValue, showColumnIds: approval.showColumnIds } } : {}),
        })
        const path = `/${input.kind === 'update' ? 'u' : 'a'}/${token}`
        const url = config.publicUrl ? `${config.publicUrl}${path}` : null
        const who = owner?.email ?? 'Someone'
        const subject = input.kind === 'update' ? `Please update a row in "${bundle.name}"` : `Your approval is needed in "${bundle.name}"`
        const text = [
          `${who} sent you ${input.kind === 'update' ? 'an update request' : 'an approval request'} for the sheet "${bundle.name}".`,
          input.message.trim(),
          url ?? `Open ${path} on the app's address.`,
          `The link works once and expires on ${new Date(expiresAt).toISOString().slice(0, 10)}. If you were not expecting this, ignore this message.`,
        ]
          .filter(Boolean)
          .join('\n\n')
        let mail: 'sent' | 'simulated' | 'skipped' | 'failed'
        if (!url) {
          mail = 'skipped' // a link without an address is no use in a mail
          await store.createNotifications(bundle.ownerId, [
            { channel: 'app', kind: 'system', sheetId: bundle.id, rowId: row.id, ruleId: input.ruleId, recipientEmail: null, title: `Not e-mailed to ${email}: set PUBLIC_APP_URL`, body: `Share this path on the app's address: ${path}`, payload: {}, frequency: 'immediately', deliverAfter: now() },
          ])
        } else {
          mail = (await outbound.send(owner, bundle.ownerId, { to: email, subject, text }, { sheetId: bundle.id, rowId: row.id, ruleId: input.ruleId })).status
        }
        items.push({ id, email, path, url, mail })
        // An approval may start with a visible "pending" value.
        if (approval?.pendingValue) await store.patchCells(row.id, { [approval.statusColumnId]: approval.pendingValue })
      }
      return { ok: true, items }
    },

    async view(rec, bundle) {
      const row = bundle.rows.find((r) => r.id === rec.rowId)
      const cells = row?.cells ?? {}
      const base = { ok: true, kind: rec.kind, sheetName: bundle.name, message: rec.message, expiresAt: new Date(rec.expiresAt).toISOString() }
      if (rec.kind === 'update') return { ...base, fields: fieldsFor(bundle.columns, rec.columnIds, cells) }
      const a = rec.approval!
      return {
        ...base,
        approveLabel: a.approvedValue,
        declineLabel: a.declinedValue,
        shown: a.showColumnIds.flatMap((id) => {
          const col = bundle.columns.find((c) => c.id === id)
          return col ? [{ title: col.title, value: isFormulaCell(cells[id]) ? '' : formatValue(cells[id]) }] : []
        }),
      }
    },

    async answerUpdate(rec, bundle, values) {
      const row = bundle.rows.find((r) => r.id === rec.rowId)
      if (!row) return { ok: false, status: 410, error: 'This row no longer exists.', state: 'gone' }
      if ((await store.lockedRows(bundle.id)).has(row.id)) return { ok: false, status: 423, error: 'This row is locked and cannot be changed now.' }
      const check = validateResponse(bundle.columns, rec.columnIds, row.cells, values, { hoursPerDay: bundle.hoursPerDay, dependenciesEnabled: bundle.dependenciesEnabled })
      if (!check.ok) return { ok: false, status: 400, error: check.error, ...(check.fieldId ? { fieldId: check.fieldId } : {}) }
      // Claim first (once), then write; if the write fails the link works again.
      if (!(await store.claimRequest('update', rec.id, 'responded', now(), { response: check.patch }))) return { ok: false, status: 410, error: 'This link has already been used.', state: 'responded' }
      const res = await store.patchCells(row.id, check.patch)
      if (!res.ok) {
        await store.reopenRequest('update', rec.id)
        return { ok: false, status: 409, error: res.error }
      }
      const lines = Object.entries(check.patch).map(([id, v]) => `${bundle.columns.find((c) => c.id === id)?.title ?? 'Column'}: ${formatValue(v) || '(blank)'}`)
      await ownerNote(rec, `${rec.email} answered an update request in "${bundle.name}"`, lines.join('\n'))
      return { ok: true }
    },

    async answerApproval(rec, bundle, decision, comment) {
      if (decision !== 'approved' && decision !== 'declined') return { ok: false, status: 400, error: 'Choose approve or decline.' }
      const text = typeof comment === 'string' ? comment.trim() : ''
      if (text.length > 2000) return { ok: false, status: 400, error: 'The comment must be at most 2000 characters.' }
      const a = rec.approval!
      const row = bundle.rows.find((r) => r.id === rec.rowId)
      if (!row) return { ok: false, status: 410, error: 'This row no longer exists.', state: 'gone' }
      if ((await store.lockedRows(bundle.id)).has(row.id)) return { ok: false, status: 423, error: 'This row is locked and cannot be changed now.' }
      if (!bundle.columns.some((c) => c.id === a.statusColumnId)) return { ok: false, status: 410, error: 'The column for the answer no longer exists.', state: 'gone' }
      if (!(await store.claimRequest('approval', rec.id, decision, now(), { comment: text || null }))) return { ok: false, status: 410, error: 'This link has already been used.', state: 'decided' }
      const res = await store.patchCells(row.id, { [a.statusColumnId]: decision === 'approved' ? a.approvedValue : a.declinedValue })
      if (!res.ok) {
        await store.reopenRequest('approval', rec.id)
        return { ok: false, status: 409, error: res.error }
      }
      await ownerNote(rec, `${rec.email} ${decision === 'approved' ? 'approved' : 'declined'} a request in "${bundle.name}"`, text || '(no comment)')
      return { ok: true }
    },
  }
}
