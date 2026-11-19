/**
 * Sending through the Meta WhatsApp Cloud API, and checking that a webhook POST really came from Meta.
 * The simulator "sends" nothing: the outbox records the message as simulated.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { WhatsAppConfig } from './config'

export interface WhatsAppProvider {
  kind: 'meta' | 'simulator'
  /** Free text: only allowed within 24 hours of the person's last message. Returns the provider's message id. */
  sendText(to: string, body: string): Promise<string>
  /** A pre-approved template with one body parameter: allowed at any time. */
  sendTemplate(to: string, template: { name: string; lang: string }, param: string): Promise<string>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    /** False for errors a retry cannot fix (bad number, policy, auth). */
    readonly retryable: boolean,
  ) {
    super(message)
  }
}

type Fetch = typeof fetch

export function createMetaProvider(cfg: Extract<WhatsAppConfig['provider'], { kind: 'meta' }>, fetchImpl: Fetch = fetch, timeoutMs = 15_000): WhatsAppProvider {
  const url = `https://graph.facebook.com/${cfg.graphVersion}/${encodeURIComponent(cfg.phoneNumberId)}/messages`
  async function post(payload: Record<string, unknown>): Promise<string> {
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw new ProviderError(`WhatsApp API unreachable: ${(err as Error).message}`, true)
    }
    const text = await res.text()
    let body: { messages?: { id?: string }[]; error?: { message?: string; code?: number } } = {}
    try {
      body = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const msg = body.error?.message ?? `HTTP ${res.status}`
      throw new ProviderError(`WhatsApp API: ${msg}`.slice(0, 500), res.status === 429 || res.status >= 500)
    }
    return body.messages?.[0]?.id ?? ''
  }
  return {
    kind: 'meta',
    sendText: (to, text) => post({ to, type: 'text', text: { preview_url: false, body: text } }),
    sendTemplate: (to, t, param) =>
      post({
        to,
        type: 'template',
        template: { name: t.name, language: { code: t.lang }, components: [{ type: 'body', parameters: [{ type: 'text', text: param }] }] },
      }),
  }
}

export function createSimulatorProvider(): WhatsAppProvider {
  let n = 0
  return {
    kind: 'simulator',
    sendText: async () => `sim.${Date.now()}.${++n}`,
    sendTemplate: async () => `sim.${Date.now()}.${++n}`,
  }
}

/** True when `header` is `sha256=<hex HMAC of the raw body with the app secret>`. Constant time. */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!appSecret || !header) return false
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim())
  if (!m) return false
  const expected = createHmac('sha256', appSecret).update(rawBody).digest()
  const given = Buffer.from(m[1], 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export interface InboundText {
  from: string
  id: string
  text: string
  /** ms since epoch */
  at: number
}

/**
 * The text messages in a Cloud API webhook payload. Buttons and interactive replies count as text;
 * other types (images, voice notes, locations) come back with an empty text so the bot can say it
 * reads text only. Status callbacks (delivered / read) are ignored.
 */
export function parseWebhook(payload: unknown): InboundText[] {
  const out: InboundText[] = []
  const entries = (payload as { entry?: unknown[] })?.entry
  if (!Array.isArray(entries)) return out
  for (const e of entries) {
    const changes = (e as { changes?: unknown[] })?.changes
    if (!Array.isArray(changes)) continue
    for (const c of changes) {
      const messages = (c as { value?: { messages?: unknown[] } })?.value?.messages
      if (!Array.isArray(messages)) continue
      for (const m of messages as Record<string, unknown>[]) {
        const from = typeof m.from === 'string' ? m.from.replace(/[^0-9]/g, '') : ''
        const id = typeof m.id === 'string' ? m.id : ''
        if (!from || !id) continue
        let text = ''
        if (m.type === 'text') text = String((m.text as { body?: string })?.body ?? '')
        else if (m.type === 'button') text = String((m.button as { text?: string })?.text ?? '')
        else if (m.type === 'interactive') {
          const i = m.interactive as { button_reply?: { title?: string }; list_reply?: { title?: string } }
          text = String(i?.button_reply?.title ?? i?.list_reply?.title ?? '')
        }
        const ts = Number(m.timestamp)
        out.push({ from, id, text: text.slice(0, 4000), at: Number.isFinite(ts) && ts > 0 ? ts * 1000 : Date.now() })
      }
    }
  }
  return out
}
