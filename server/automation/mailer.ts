/**
 * E-mail delivery behind one small interface. `simulator` sends nothing (the worker writes the
 * message to the owner's notification centre instead); `resend` posts to the Resend HTTP API.
 * Adding another provider means implementing `Mailer`; nothing else changes.
 */
export interface MailMessage {
  to: string
  subject: string
  text: string
  /** Where replies go (the rule owner's address, when known). */
  replyTo?: string
}

export interface Mailer {
  readonly kind: 'resend' | 'simulator'
  send(msg: MailMessage): Promise<{ id: string | null }>
}

export function createSimulatorMailer(): Mailer {
  return { kind: 'simulator', send: async () => ({ id: null }) }
}

export interface ResendOptions {
  apiKey: string
  from: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export function createResendMailer(opts: ResendOptions): Mailer {
  const doFetch = opts.fetch ?? fetch
  return {
    kind: 'resend',
    async send(msg) {
      const res = await doFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: opts.from, to: [msg.to], subject: msg.subject, text: msg.text, ...(msg.replyTo ? { reply_to: msg.replyTo } : {}) }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      })
      if (!res.ok) {
        // The body can echo the request; keep only a short, key-free reason.
        let reason = ''
        try {
          const j = (await res.json()) as { message?: string; name?: string }
          reason = j.message ?? j.name ?? ''
        } catch {
          /* no body */
        }
        throw new Error(`Mail provider answered ${res.status}${reason ? `: ${reason.slice(0, 120)}` : ''}`)
      }
      const j = (await res.json().catch(() => ({}))) as { id?: string }
      return { id: j.id ?? null }
    },
  }
}
