/**
 * Sending one message on behalf of an owner, with the safeguards that stop the app from being used to
 * spam: real e-mail only goes out for owners with a real (non-anonymous) account unless the operator
 * allows it, and each owner has a daily cap. When a message is NOT e-mailed (simulator, policy, cap,
 * failure) the owner gets it in their notification centre instead, so nothing is silently lost.
 */
import type { Logger } from '../log'
import type { AutomationConfig } from './config'
import type { MailMessage, Mailer } from './mailer'
import type { AutomationStore, OwnerInfo } from './store'

export type SendStatus = 'sent' | 'simulated' | 'skipped' | 'failed'

export interface SendContext {
  sheetId: string | null
  rowId: string | null
  ruleId: string | null
  /** Shown to the owner when the message is not e-mailed. Defaults to the message itself. */
  ownerCopy?: string
}

export interface Outbound {
  send(owner: OwnerInfo | null, ownerId: string, msg: MailMessage, ctx: SendContext): Promise<{ status: SendStatus; error: string | null }>
}

const DAY_MS = 86_400_000

export function createOutbound(deps: { config: Pick<AutomationConfig, 'emailPerOwnerPerDay' | 'allowAnonymousEmail'>; mailer: Mailer; store: AutomationStore; now: () => number; log: Logger }): Outbound {
  const { config, mailer, store, now, log } = deps
  // E-mails sent in this process per owner since the last database count, so a burst cannot overshoot the cap.
  const sentToday = new Map<string, { at: number; n: number }>()

  async function used(ownerId: string): Promise<number> {
    const t = now()
    const hit = sentToday.get(ownerId)
    if (hit && t - hit.at < 60_000) return hit.n
    const n = await store.emailsSentSince(ownerId, t - DAY_MS)
    sentToday.set(ownerId, { at: t, n })
    return n
  }

  async function toOwner(ownerId: string, why: string, msg: MailMessage, ctx: SendContext) {
    await store.createNotifications(ownerId, [
      {
        channel: 'app',
        kind: 'system',
        sheetId: ctx.sheetId,
        rowId: ctx.rowId,
        ruleId: ctx.ruleId,
        recipientEmail: null,
        title: `Not e-mailed to ${msg.to}: ${msg.subject}`.slice(0, 200),
        body: `${why}\n\n${ctx.ownerCopy ?? msg.text}`.slice(0, 4800),
        payload: { to: msg.to },
        frequency: 'immediately',
        deliverAfter: now(),
      },
    ])
  }

  return {
    async send(owner, ownerId, msg, ctx) {
      try {
        if (mailer.kind === 'simulator') {
          await toOwner(ownerId, 'E-mail is simulated on this server (no mail provider is configured), so this is what would have been sent.', msg, ctx)
          return { status: 'simulated', error: null }
        }
        if (!owner || (owner.anonymous && !config.allowAnonymousEmail)) {
          const why = 'E-mail is only sent for signed-in accounts.'
          await toOwner(ownerId, why, msg, ctx)
          return { status: 'skipped', error: why }
        }
        if ((await used(ownerId)) >= config.emailPerOwnerPerDay) {
          const why = `The daily limit of ${config.emailPerOwnerPerDay} e-mails was reached.`
          await toOwner(ownerId, why, msg, ctx)
          return { status: 'skipped', error: why }
        }
        await mailer.send({ ...msg, ...(owner.email ? { replyTo: owner.email } : {}) })
        const hit = sentToday.get(ownerId)
        if (hit) hit.n += 1
        return { status: 'sent', error: null }
      } catch (err) {
        const error = err instanceof Error ? err.message : 'The mail provider failed.'
        log('automation.mail.failed', { ownerId, error })
        await toOwner(ownerId, `The e-mail could not be sent: ${error}`, msg, ctx).catch(() => {})
        return { status: 'failed', error }
      }
    },
  }
}
