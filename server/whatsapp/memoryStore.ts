/**
 * An in-memory WhatsAppStore for tests: the same contract as the Supabase store, with the state in
 * plain arrays and maps that tests can inspect.
 */
import type { SheetData } from '../../src/store/persistence'
import type { Contact, Link, NudgeRow, OutRow, Outgoing, PendingRuleMessage, Session, SessionState, SheetSettings, WhatsAppStore } from './store'

export interface MemoryMessage extends OutRow {
  direction: 'in' | 'out'
  status: string
  nextAttemptAt: number
  providerId: string | null
  error: string | null
  sentAt: number | null
  createdAt: number
}

export interface MemoryState {
  links: Link[]
  contacts: Contact[]
  codes: { hash: string; kind: 'link' | 'join'; userId: string | null; contactId: string | null; expiresAt: number; usedAt: number | null }[]
  optouts: Set<string>
  sessions: Map<string, Session>
  messages: MemoryMessage[]
  sheets: Map<string, SheetData>
  settings: Map<string, SheetSettings>
  locks: Set<string>
  nudges: NudgeRow[]
  ruleMessages: (PendingRuleMessage & { status: string; error: string | null; deliverAfter: number })[]
  inApp: { ownerId: string; sheetId: string | null; rowId: string | null; title: string; body: string }[]
  accounts: Map<string, { email: string | null; anonymous: boolean }>
}

export function createMemoryStore(now: () => number = Date.now): WhatsAppStore & { state: MemoryState; outbound(phone?: string): MemoryMessage[] } {
  const s: MemoryState = {
    links: [],
    contacts: [],
    codes: [],
    optouts: new Set(),
    sessions: new Map(),
    messages: [],
    sheets: new Map(),
    settings: new Map(),
    locks: new Set(),
    nudges: [],
    ruleMessages: [],
    inApp: [],
    accounts: new Map(),
  }
  let seq = 0
  const clone = <T>(v: T): T => structuredClone(v)

  return {
    state: s,
    outbound: (phone) => s.messages.filter((m) => m.direction === 'out' && (!phone || m.phone === phone)),

    async linkByPhone(phone) {
      return s.links.find((l) => l.phone === phone) ?? null
    },
    async linkByUser(userId) {
      return s.links.find((l) => l.userId === userId) ?? null
    },
    async linkPhone(userId, email, phone) {
      s.links = s.links.filter((l) => l.userId !== userId && l.phone !== phone)
      s.links.push({ userId, email: email?.toLowerCase() ?? null, phone })
    },
    async linksByEmails(emails) {
      const set = new Set(emails.map((e) => e.toLowerCase()))
      return s.links.filter((l) => l.email && set.has(l.email))
    },
    async contact(id) {
      return s.contacts.find((c) => c.id === id) ?? null
    },
    async activeContactsByPhone(phone) {
      return s.contacts.filter((c) => c.phone === phone && c.status === 'active')
    },
    async ownerContactsByEmails(ownerId, emails) {
      const set = new Set(emails.map((e) => e.toLowerCase()))
      return s.contacts.filter((c) => c.ownerId === ownerId && c.status === 'active' && set.has(c.email))
    },
    async contactOwnersOfPhone(phone) {
      return [...new Set(s.contacts.filter((c) => c.phone === phone).map((c) => c.ownerId))]
    },
    async activateContact(id) {
      const c = s.contacts.find((x) => x.id === id)
      if (c) c.status = 'active'
    },
    async createCode(c) {
      s.codes.push({ hash: c.hash, kind: c.kind, userId: c.userId ?? null, contactId: c.contactId ?? null, expiresAt: c.expiresAt, usedAt: null })
    },
    async takeCode(hash, at) {
      const c = s.codes.find((x) => x.hash === hash && x.usedAt === null && x.expiresAt > at)
      if (!c) return null
      c.usedAt = at
      return { kind: c.kind, userId: c.userId, contactId: c.contactId }
    },

    async isOptedOut(phone) {
      return s.optouts.has(phone)
    },
    async setOptOut(phone, out) {
      if (out) s.optouts.add(phone)
      else s.optouts.delete(phone)
    },

    async session(phone) {
      return clone(s.sessions.get(phone) ?? { state: {}, lastInboundAt: null })
    },
    async saveSession(phone, state: SessionState, lastInboundAt) {
      const cur = s.sessions.get(phone)
      s.sessions.set(phone, { state: clone(state), lastInboundAt: lastInboundAt !== undefined ? lastInboundAt : (cur?.lastInboundAt ?? null) })
    },

    async recordInbound(m) {
      if (m.providerId && s.messages.some((x) => x.direction === 'in' && x.providerId === m.providerId)) return false
      s.messages.push({
        id: `m${++seq}`,
        direction: 'in',
        ownerId: m.ownerId,
        phone: m.phone,
        body: m.body,
        kind: 'reply',
        priority: 'MEDIUM',
        sheetId: null,
        rowId: null,
        dedupKey: null,
        attempts: 0,
        status: 'received',
        nextAttemptAt: now(),
        providerId: m.providerId,
        error: null,
        sentAt: null,
        createdAt: now(),
      })
      return true
    },
    async enqueue(m: Outgoing) {
      if (m.dedupKey && s.messages.some((x) => x.dedupKey === m.dedupKey)) return false
      s.messages.push({
        id: `m${++seq}`,
        direction: 'out',
        ownerId: m.ownerId,
        phone: m.phone,
        body: m.body,
        kind: m.kind,
        priority: m.priority,
        sheetId: m.sheetId ?? null,
        rowId: m.rowId ?? null,
        dedupKey: m.dedupKey ?? null,
        attempts: 0,
        status: 'pending',
        nextAttemptAt: m.notBefore ?? now(),
        providerId: null,
        error: null,
        sentAt: null,
        createdAt: now(),
      })
      return true
    },
    async due(nowMs, limit) {
      const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 }
      return s.messages
        .filter((m) => m.direction === 'out' && m.status === 'pending' && m.nextAttemptAt <= nowMs)
        .sort((a, b) => rank[a.priority] - rank[b.priority] || a.nextAttemptAt - b.nextAttemptAt)
        .slice(0, limit)
        .map((m) => ({ id: m.id, ownerId: m.ownerId, phone: m.phone, body: m.body, kind: m.kind, priority: m.priority, sheetId: m.sheetId, rowId: m.rowId, dedupKey: m.dedupKey, attempts: m.attempts }))
    },
    async markMessage(id, p) {
      const m = s.messages.find((x) => x.id === id)
      if (!m) return
      m.status = p.status
      if (p.attempts !== undefined) m.attempts = p.attempts
      if (p.nextAttemptAt !== undefined) m.nextAttemptAt = p.nextAttemptAt
      if (p.providerId !== undefined) m.providerId = p.providerId
      if (p.error !== undefined) m.error = p.error
      if (p.sentAt !== undefined) m.sentAt = p.sentAt
    },
    async sentSince(ownerId, since) {
      return s.messages.filter((m) => m.direction === 'out' && m.ownerId === ownerId && m.status === 'sent' && (m.sentAt ?? 0) >= since).length
    },

    async ownedSheets(userId, limit) {
      return [...s.sheets.values()]
        .filter((d) => d.sheet.ownerId === userId)
        .slice(0, limit)
        .map((d) => ({ id: d.sheet.id, name: d.sheet.name }))
    },
    async sheetMeta(sheetId) {
      const d = s.sheets.get(sheetId)
      return d ? { id: d.sheet.id, name: d.sheet.name, ownerId: d.sheet.ownerId } : null
    },
    async loadSheet(sheetId) {
      const d = s.sheets.get(sheetId)
      return d ? clone(d) : null
    },
    async settings(sheetId) {
      return s.settings.get(sheetId) ?? null
    },
    async enabledSettings() {
      return [...s.settings.values()].filter((x) => x.enabled)
    },
    async patchCells(rowId, patch) {
      for (const d of s.sheets.values()) {
        const r = d.rows.find((x) => x.id === rowId)
        if (r) {
          r.cells = { ...r.cells, ...patch }
          r.version += 1
          return { ok: true }
        }
      }
      return { ok: false, error: 'The row no longer exists.' }
    },
    async isRowLocked(rowId) {
      return s.locks.has(rowId)
    },

    async nudges(sheetId) {
      return s.nudges.filter((n) => n.sheetId === sheetId).map((n) => ({ ...n }))
    },
    async saveNudge(n) {
      s.nudges = s.nudges.filter((x) => !(x.rowId === n.rowId && x.milestone === n.milestone && x.phone === n.phone))
      s.nudges.push({ ...n })
    },
    async answerNudges(rowId, phone, at) {
      for (const n of s.nudges) if (n.rowId === rowId && n.phone === phone && n.answeredAt === null) n.answeredAt = at
    },

    async pendingRuleMessages(nowMs, limit) {
      return s.ruleMessages.filter((m) => m.status === 'pending' && m.deliverAfter <= nowMs).slice(0, limit)
    },
    async markRuleMessage(id, status, error) {
      const m = s.ruleMessages.find((x) => x.id === id)
      if (m) {
        m.status = status
        m.error = error
      }
    },
    async notifyInApp(ownerId, n) {
      s.inApp.push({ ownerId, ...n })
    },
    async account(userId) {
      return s.accounts.get(userId) ?? null
    },
  }
}
