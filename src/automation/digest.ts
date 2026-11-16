/**
 * Digest batching: notifications with frequency daily / weekly wait until their `deliverAfter` and
 * are then sent as ONE message per recipient and owner, however many rows triggered them. Immediate
 * notifications are never merged. Pure.
 */
import type { Frequency } from './types'

export interface PendingEmail {
  id: string
  ownerId: string
  recipientEmail: string
  frequency: Frequency
  subject: string
  body: string
  /** Link to the row (absolute URL) or null. */
  link: string | null
  /** ms since epoch. */
  deliverAfter: number
}

export interface OutgoingEmail {
  ownerId: string
  recipientEmail: string
  subject: string
  text: string
  /** The pending notifications this message covers. */
  ids: string[]
}

const DIGEST_LIMIT = 50

/** The e-mails that are due at `now`, and which pending notifications each one consumes. */
export function batchDigests(pending: readonly PendingEmail[], now: number): OutgoingEmail[] {
  const due = pending.filter((p) => p.deliverAfter <= now).sort((a, b) => a.deliverAfter - b.deliverAfter || a.id.localeCompare(b.id))
  const out: OutgoingEmail[] = []
  const groups = new Map<string, PendingEmail[]>()
  for (const p of due) {
    if (p.frequency === 'immediately') {
      out.push({ ownerId: p.ownerId, recipientEmail: p.recipientEmail, subject: p.subject, text: renderOne(p), ids: [p.id] })
      continue
    }
    const key = `${p.ownerId}|${p.recipientEmail}`
    groups.set(key, [...(groups.get(key) ?? []), p])
  }
  for (const items of groups.values()) {
    if (items.length === 1) {
      const p = items[0]
      out.push({ ownerId: p.ownerId, recipientEmail: p.recipientEmail, subject: p.subject, text: renderOne(p), ids: [p.id] })
      continue
    }
    const shown = items.slice(0, DIGEST_LIMIT)
    const more = items.length - shown.length
    const text = [
      `${items.length} updates:`,
      '',
      ...shown.map((p) => `- ${p.subject}\n${indent(p.body)}${p.link ? `\n  ${p.link}` : ''}`),
      ...(more > 0 ? ['', `...and ${more} more.`] : []),
    ].join('\n')
    out.push({
      ownerId: items[0].ownerId,
      recipientEmail: items[0].recipientEmail,
      subject: `${items.length} updates`,
      text,
      ids: items.map((p) => p.id),
    })
  }
  return out
}

const indent = (s: string) =>
  s
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')

function renderOne(p: PendingEmail): string {
  return (p.link ? `${p.body}\n\n${p.link}` : p.body).trim()
}
