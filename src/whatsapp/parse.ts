/**
 * Reading an inbound WhatsApp text: menu picks, "#N" details, "N <status> [- comment]" updates,
 * "N 60%" progress, LINK / JOIN codes, STOP / START, or free text for the AI. Pure.
 */
import { isDoneStatus } from './tasks'

export type Command =
  | { kind: 'stop' }
  | { kind: 'start' }
  | { kind: 'menu' }
  | { kind: 'help' }
  | { kind: 'switch' }
  | { kind: 'email' }
  | { kind: 'yes' }
  | { kind: 'link'; code: string }
  | { kind: 'join'; code: string }
  | { kind: 'number'; n: number }
  | { kind: 'detail'; n: number }
  | { kind: 'update'; n: number; status: string | null; percent: number | null; comment: string }
  | { kind: 'answer'; status: string | null; percent: number | null; comment: string }
  | { kind: 'text'; text: string }

export const CODE_RE = /^[A-Z0-9]{6,10}$/

const GREETING = /^(hi+|hello+|hey+|hiya|hola|salam|salaam|marhaba|namaste|yo|good (morning|afternoon|evening)|menu|start over|projects?)\b[\s!.,]*$/i

/** Splits "In progress - waiting for steel" into status and comment (dash, en / em dash or colon). */
export function splitComment(s: string): { head: string; comment: string } {
  const m = /^(.*?)(?:\s+[-–—]\s*|\s*[–—:]\s*)(.*)$/s.exec(s)
  if (!m || !m[1].trim()) return { head: s.trim(), comment: '' }
  return { head: m[1].trim(), comment: m[2].trim() }
}

function statusOrPercent(head: string): { status: string | null; percent: number | null } {
  const pct = /^(\d{1,3})\s*%$/.exec(head)
  if (pct) {
    const n = Number(pct[1])
    return n <= 100 ? { status: null, percent: n } : { status: head, percent: null }
  }
  return { status: head, percent: null }
}

export function parseCommand(raw: string): Command {
  const text = raw.trim().replace(/\s+/g, ' ')
  const up = text.toUpperCase()
  if (/^(STOP|UNSUBSCRIBE|STOP ALL|OPT ?OUT)$/.test(up)) return { kind: 'stop' }
  if (/^(START|RESUME|UNSTOP)$/.test(up)) return { kind: 'start' }
  if (/^(HELP|\?)$/.test(up)) return { kind: 'help' }
  if (/^(0|SWITCH|SWITCH PROJECT|CHANGE PROJECT)$/.test(up)) return { kind: 'switch' }
  if (/^(EMAIL|E-MAIL|MAIL ME|SEND EMAIL)$/.test(up)) return { kind: 'email' }
  if (/^(YES|Y|OK|OKAY|ACCEPT)$/.test(up)) return { kind: 'yes' }
  const link = /^LINK\s+([A-Z0-9]{6,10})$/.exec(up)
  if (link) return { kind: 'link', code: link[1] }
  const join = /^JOIN\s+([A-Z0-9]{6,10})$/.exec(up)
  if (join) return { kind: 'join', code: join[1] }
  if (GREETING.test(text)) return { kind: 'menu' }
  const num = /^(\d{1,3})[.)]?$/.exec(text)
  if (num) return { kind: 'number', n: Number(num[1]) }
  const det = /^#\s*(\d{1,3})$/.exec(text)
  if (det) return { kind: 'detail', n: Number(det[1]) }
  // "60%" or "60% - slow deliveries" on its own answers a progress check.
  const lonePct = /^(\d{1,3})\s*%(.*)$/.exec(text)
  if (lonePct && Number(lonePct[1]) <= 100) {
    const rest = lonePct[2].trim().replace(/^[-–—:]\s*/, '')
    return { kind: 'answer', status: null, percent: Number(lonePct[1]), comment: rest }
  }
  const upd = /^(\d{1,3})\s*[.):]?\s+(.+)$/s.exec(text)
  if (upd) {
    // "2 - crane down": a number and a note only (answers a progress check with choice 2).
    const noteOnly = /^[-–—:]\s*(.*)$/s.exec(upd[2])
    if (noteOnly) return { kind: 'update', n: Number(upd[1]), status: null, percent: null, comment: noteOnly[1].trim() }
    const { head, comment } = splitComment(upd[2])
    if (head) return { kind: 'update', n: Number(upd[1]), ...statusOrPercent(head), comment }
  }
  return { kind: 'text', text }
}

const SYNONYMS: { re: RegExp; want: RegExp }[] = [
  { re: /^(done|finished|completed?|closed|ok done|100%?)$/i, want: /complete|done|finish|closed/i },
  { re: /^(wip|ongoing|started|in prog(ress)?|progress|working|on ?track)$/i, want: /progress|on ?track|ongoing|^started/i },
  { re: /^(blocked|stuck|on ?hold|hold|paused|waiting)$/i, want: /hold|block|stuck|wait/i },
  { re: /^(delayed|late|behind|slipping)$/i, want: /delay|late|behind|risk|hold/i },
  { re: /^(not ?started|pending|todo|to do|open)$/i, want: /not started|pending|to ?do|open/i },
]

/**
 * The status option `input` means, or null. Exact (case-insensitive), then prefix, then synonyms.
 * With no options (a text status column) the input itself is used.
 */
export function matchStatus(input: string, options: readonly string[] | undefined): string | null {
  const s = input.trim()
  if (!s) return null
  if (!options || options.length === 0) return s.slice(0, 100)
  const lower = s.toLowerCase()
  const exact = options.find((o) => o.toLowerCase() === lower)
  if (exact) return exact
  const prefix = options.filter((o) => o.toLowerCase().startsWith(lower))
  if (prefix.length === 1) return prefix[0]
  for (const { re, want } of SYNONYMS) {
    if (!re.test(s)) continue
    const hit = options.find((o) => want.test(o)) ?? (re === SYNONYMS[0].re ? options.find((o) => isDoneStatus(o)) : undefined)
    if (hit) return hit
  }
  return null
}

/** The four quick answers to a delay alert or progress check, by number. */
export function quickAnswer(n: number): 'On track' | 'Delayed' | 'Complete' | 'Blocked' | null {
  return (['On track', 'Delayed', 'Complete', 'Blocked'] as const)[n - 1] ?? null
}
