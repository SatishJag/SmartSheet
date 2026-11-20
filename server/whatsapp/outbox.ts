/**
 * The outbox: every outbound message is queued in `whatsapp_messages` and delivered by `deliver()`,
 * which applies the rules that keep the platform within WhatsApp's policy and the account's limits:
 *
 *   - STOP is honoured for every account (only `system` confirmations still go to an opted-out phone,
 *     and those are only ever replies to the person's own message);
 *   - free text only within 24 hours of the person's last message; outside it the configured template
 *     (one body parameter: the message flattened to a line), or the message is skipped and says why;
 *   - a daily cap per account;
 *   - retries with backoff for transient provider errors (3 attempts).
 *
 * Do-not-disturb is applied when a message is queued (`notBefore`): HIGH priority ignores it.
 */
import { chunkMessage, templateParam } from '../../src/whatsapp/format'
import { inQuietHours, localTime, minutesUntilQuietEnds } from '../../src/whatsapp/time'
import type { Logger } from '../log'
import type { WhatsAppConfig } from './config'
import { ProviderError, type WhatsAppProvider } from './provider'
import type { Contact, Outgoing, Priority, WhatsAppStore } from './store'

const DAY_MS = 86_400_000
const WINDOW_MS = 24 * 3_600_000
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000]
const MAX_ATTEMPTS = 3

export interface Quiet {
  timeZone: string
  dndStart: string
  dndEnd: string
}

/** When a message of `priority` may go out, given quiet hours (ms). */
export function notBefore(nowMs: number, priority: Priority, quiet: Quiet | null): number {
  if (!quiet || priority === 'HIGH') return nowMs
  const t = localTime(nowMs, quiet.timeZone)
  if (!inQuietHours(t, quiet.dndStart, quiet.dndEnd)) return nowMs
  return nowMs + minutesUntilQuietEnds(t, quiet.dndStart, quiet.dndEnd) * 60_000
}

/** Queues `m`, split into WhatsApp-sized parts. False when its dedup key was already used. */
export async function queue(store: WhatsAppStore, m: Outgoing, nowMs: number, quiet: Quiet | null = null): Promise<boolean> {
  const parts = chunkMessage(m.body)
  const at = m.notBefore ?? notBefore(nowMs, m.priority, quiet)
  let first = true
  for (let i = 0; i < parts.length; i++) {
    const ok = await store.enqueue({ ...m, body: parts[i], notBefore: at + i, dedupKey: m.dedupKey ? (i === 0 ? m.dedupKey : `${m.dedupKey}#${i}`) : null })
    if (i === 0 && !ok) return false
    first = first && ok
  }
  return first
}

export interface Recipient {
  phone: string
  /** Display name for the account's messages ("Ravi (MEP)"). */
  label: string
  email: string
  via: 'user' | 'contact'
}

/**
 * The phones that may receive messages about `ownerId`'s sheets for these e-mails: the owner's active
 * site contacts with that e-mail, and planner users who linked a phone under that e-mail. Opted-out
 * phones are dropped. One entry per phone.
 */
export async function resolveRecipients(store: WhatsAppStore, ownerId: string, emails: string[]): Promise<Recipient[]> {
  const wanted = [...new Set(emails.map((e) => e.toLowerCase()).filter(Boolean))]
  if (wanted.length === 0) return []
  const [contacts, links] = await Promise.all([store.ownerContactsByEmails(ownerId, wanted), store.linksByEmails(wanted)])
  const out = new Map<string, Recipient>()
  for (const c of contacts as Contact[]) out.set(c.phone, { phone: c.phone, label: c.name, email: c.email, via: 'contact' })
  for (const l of links) if (!out.has(l.phone) && l.email) out.set(l.phone, { phone: l.phone, label: l.email.split('@')[0], email: l.email, via: 'user' })
  const result: Recipient[] = []
  for (const r of out.values()) if (!(await store.isOptedOut(r.phone))) result.push(r)
  return result
}

export interface Deliverer {
  deliver(): Promise<{ sent: number; skipped: number; failed: number }>
}

export function createDeliverer(deps: { store: WhatsAppStore; provider: WhatsAppProvider; config: Pick<WhatsAppConfig, 'template' | 'perOwnerPerDay'>; now: () => number; log: Logger }): Deliverer {
  const { store, provider, config, now, log } = deps
  let running = false
  return {
    async deliver() {
      const totals = { sent: 0, skipped: 0, failed: 0 }
      if (running) return totals
      running = true
      try {
        const due = await store.due(now(), 200)
        const used = new Map<string, number>()
        for (const m of due) {
          const t = now()
          if (m.kind !== 'system' && (await store.isOptedOut(m.phone))) {
            await store.markMessage(m.id, { status: 'skipped', error: 'The recipient replied STOP.' })
            totals.skipped++
            continue
          }
          if (m.ownerId) {
            if (!used.has(m.ownerId)) used.set(m.ownerId, await store.sentSince(m.ownerId, t - DAY_MS))
            if ((used.get(m.ownerId) ?? 0) >= config.perOwnerPerDay) {
              await store.markMessage(m.id, { status: 'skipped', error: `The daily limit of ${config.perOwnerPerDay} WhatsApp messages was reached.` })
              totals.skipped++
              continue
            }
          }
          const session = await store.session(m.phone)
          const inWindow = session.lastInboundAt !== null && t - session.lastInboundAt < WINDOW_MS
          if (!inWindow && !config.template && provider.kind !== 'simulator') {
            await store.markMessage(m.id, { status: 'skipped', error: 'Outside WhatsApp’s 24-hour window and no message template is configured (WHATSAPP_TEMPLATE_NAME).' })
            totals.skipped++
            continue
          }
          try {
            const id = inWindow || !config.template ? await provider.sendText(m.phone, m.body) : await provider.sendTemplate(m.phone, config.template, templateParam(m.body))
            await store.markMessage(m.id, { status: provider.kind === 'simulator' ? 'simulated' : 'sent', attempts: m.attempts + 1, providerId: id || null, sentAt: t, error: null })
            if (m.ownerId && provider.kind !== 'simulator') used.set(m.ownerId, (used.get(m.ownerId) ?? 0) + 1)
            totals.sent++
          } catch (err) {
            const attempts = m.attempts + 1
            const retry = !(err instanceof ProviderError) || err.retryable
            const msg = (err as Error).message
            if (retry && attempts < MAX_ATTEMPTS) {
              await store.markMessage(m.id, { status: 'pending', attempts, nextAttemptAt: t + BACKOFF_MS[attempts - 1], error: msg })
            } else {
              await store.markMessage(m.id, { status: 'failed', attempts, error: msg })
              totals.failed++
            }
            log('whatsapp.send.failed', { id: m.id, attempts, retry, error: msg })
          }
        }
      } finally {
        running = false
      }
      return totals
    },
  }
}
