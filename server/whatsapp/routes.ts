/**
 * The WhatsApp HTTP routes.
 *
 *   GET  /api/whatsapp/webhook                 Meta     the verify challenge (WHATSAPP_VERIFY_TOKEN)
 *   POST /api/whatsapp/webhook                 Meta     inbound messages; X-Hub-Signature-256 checked first
 *   GET  /api/whatsapp/status                  signed in  mode, the caller's linked phone, business number
 *   POST /api/whatsapp/link                    signed in  a LINK code (30 minutes) and its wa.me link
 *   POST /api/whatsapp/contacts/:id/invite     signed in  a JOIN code (14 days) for one of the caller's contacts
 *   POST /api/whatsapp/sheets/:id/summary      signed in  the sheet's summary to the owner's phone now
 *   POST /api/whatsapp/sheets/:id/check        signed in  run the sheet's alerts now
 *   POST /api/whatsapp/simulate                signed in  simulator only: a message "from" a phone the caller
 *                                                         controls (their link, their contacts, or a new number)
 *
 * The webhook answers 200 as soon as the signature is checked and the messages are recorded (Meta
 * retries slow or failed deliveries); replies leave through the outbox.
 */
import { randomInt } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { maskPhone, normalizePhone } from '../../src/whatsapp/phone'
import { HttpError, readJsonBody, sendJson, type Limiter, createLimiter } from '../automation/http'
import type { Logger } from '../log'
import type { Alerts } from './alerts'
import type { WhatsAppConfig } from './config'
import { hashCode, type Conversation } from './conversation'
import type { Deliverer } from './outbox'
import { parseWebhook, verifySignature } from './provider'
import type { WhatsAppStore } from './store'

export interface WhatsAppRouteDeps {
  config: WhatsAppConfig
  /** Null when the server has no service-role key: every route answers 503 with `disabledReason`. */
  store: WhatsAppStore | null
  conversation: Conversation | null
  alerts: Alerts | null
  deliverer: Deliverer | null
  disabledReason?: string
  authenticate: ((token: string) => Promise<{ userId: string } | null>) | null
  ai: boolean
  now: () => number
  log: Logger
}

const WEBHOOK_LIMIT = 512 * 1024
const BODY_LIMIT = 8 * 1024
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O, 1/I
const LINK_TTL_MS = 30 * 60_000
const JOIN_TTL_MS = 14 * 86_400_000

export function newCode(length = 8): string {
  let s = ''
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return s
}

function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new HttpError(413, 'Payload too large.'))
        req.removeAllListeners('data')
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function createWhatsAppRoutes(deps: WhatsAppRouteDeps) {
  const { config, log, now } = deps
  const perUser: Limiter = createLimiter(30, 60_000, now)

  async function user(req: IncomingMessage): Promise<string> {
    if (!deps.authenticate) throw new HttpError(503, 'The server is not configured for sign-in.')
    const m = /^Bearer[ ]+([^\s]+)\s*$/i.exec(req.headers.authorization ?? '')
    if (!m || m[1].length > 8192) throw new HttpError(401, 'Sign in first (missing bearer token).', { 'WWW-Authenticate': 'Bearer' })
    let u: { userId: string } | null
    try {
      u = await deps.authenticate(m[1])
    } catch (err) {
      log('whatsapp.auth.error', { error: (err as Error).message })
      throw new HttpError(503, 'Could not verify your session. Try again shortly.')
    }
    if (!u) throw new HttpError(401, 'Your session is invalid or has expired. Sign in again.', { 'WWW-Authenticate': 'Bearer' })
    if (!perUser.hit(u.userId)) throw new HttpError(429, 'Too many requests. Try again in a minute.', { 'Retry-After': '60' })
    return u.userId
  }

  function ready() {
    if (!deps.store || !deps.conversation || !deps.alerts || !deps.deliverer) throw new HttpError(503, deps.disabledReason ?? 'WhatsApp is off on this server.')
    return { store: deps.store, conversation: deps.conversation, alerts: deps.alerts, deliverer: deps.deliverer }
  }

  const waLink = (text: string) => (config.businessNumber ? `https://wa.me/${config.businessNumber}?text=${encodeURIComponent(text)}` : null)

  async function ownSheet(store: WhatsAppStore, userId: string, sheetId: string) {
    const meta = /^[0-9a-f-]{36}$/i.test(sheetId) ? await store.sheetMeta(sheetId) : null
    if (!meta || meta.ownerId !== userId) throw new HttpError(404, 'That sheet was not found.')
    return meta
  }

  async function webhookGet(req: IncomingMessage, res: ServerResponse, url: URL) {
    const mode = url.searchParams.get('hub.mode')
    const token = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge') ?? ''
    if (mode === 'subscribe' && config.verifyToken && token === config.verifyToken && /^[\w.-]{1,200}$/.test(challenge)) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(challenge)
      return
    }
    void req
    throw new HttpError(403, 'Verification failed.')
  }

  async function webhookPost(req: IncomingMessage, res: ServerResponse) {
    const { conversation, deliverer } = ready()
    if (config.provider.kind !== 'meta') throw new HttpError(404, 'WhatsApp is in simulator mode on this server.')
    const raw = await readRaw(req, WEBHOOK_LIMIT)
    const sig = req.headers['x-hub-signature-256']
    if (!verifySignature(raw, Array.isArray(sig) ? sig[0] : sig, config.appSecret)) {
      log('whatsapp.webhook.bad_signature', {})
      throw new HttpError(401, 'Invalid signature.')
    }
    let payload: unknown
    try {
      payload = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new HttpError(400, 'Not JSON.')
    }
    const messages = parseWebhook(payload)
    sendJson(res, 200, { ok: true })
    for (const m of messages) {
      try {
        await conversation.handle(m.from, m.text, m.id)
      } catch (err) {
        log('whatsapp.webhook.failed', { error: (err as Error).message })
      }
    }
    if (messages.length) await deliverer.deliver().catch((err) => log('whatsapp.deliver.failed', { error: (err as Error).message }))
  }

  async function status(req: IncomingMessage, res: ServerResponse) {
    const userId = await user(req)
    const link = deps.store ? await deps.store.linkByUser(userId) : null
    sendJson(res, 200, {
      ok: true,
      enabled: deps.store !== null,
      reason: deps.store ? null : (deps.disabledReason ?? null),
      mode: config.provider.kind,
      businessNumber: config.businessNumber || null,
      template: config.template !== null,
      ai: deps.ai,
      linked: link ? { phone: link.phone, masked: maskPhone(link.phone) } : null,
    })
  }

  async function link(req: IncomingMessage, res: ServerResponse) {
    const userId = await user(req)
    const { store } = ready()
    const account = await store.account(userId)
    if (!account || account.anonymous) throw new HttpError(403, 'Sign in with an e-mail account to link WhatsApp.')
    const code = newCode()
    await store.createCode({ hash: hashCode(code), kind: 'link', userId, expiresAt: now() + LINK_TTL_MS })
    const text = `LINK ${code}`
    sendJson(res, 200, { ok: true, code, text, waLink: waLink(text), expiresAt: new Date(now() + LINK_TTL_MS).toISOString() })
  }

  async function invite(req: IncomingMessage, res: ServerResponse, contactId: string) {
    const userId = await user(req)
    const { store } = ready()
    const contact = /^[0-9a-f-]{36}$/i.test(contactId) ? await store.contact(contactId) : null
    if (!contact || contact.ownerId !== userId) throw new HttpError(404, 'That contact was not found.')
    const account = await store.account(userId)
    const code = newCode()
    await store.createCode({ hash: hashCode(code), kind: 'join', contactId: contact.id, expiresAt: now() + JOIN_TTL_MS })
    const text = `JOIN ${code}`
    const link = waLink(text)
    const message = [
      `Hi ${contact.name}, ${account?.email ?? 'we'} would like to send you task updates for our project on WhatsApp.`,
      link ? `Tap this link and press send to accept: ${link}` : `Send "${text}" to our WhatsApp number to accept.`,
      'You can reply STOP at any time.',
    ].join('\n')
    sendJson(res, 200, { ok: true, code, text, waLink: link, message, expiresAt: new Date(now() + JOIN_TTL_MS).toISOString() })
  }

  async function summary(req: IncomingMessage, res: ServerResponse, sheetId: string) {
    const userId = await user(req)
    const { store, alerts, deliverer } = ready()
    await ownSheet(store, userId, sheetId)
    if (!(await store.linkByUser(userId))) throw new HttpError(409, 'Link your phone first.')
    const ok = await alerts.summaryNow(sheetId)
    await deliverer.deliver()
    sendJson(res, 200, { ok })
  }

  async function check(req: IncomingMessage, res: ServerResponse, sheetId: string) {
    const userId = await user(req)
    const { store, alerts, deliverer } = ready()
    await ownSheet(store, userId, sheetId)
    const settings = await store.settings(sheetId)
    if (!settings?.enabled) throw new HttpError(409, 'Turn on WhatsApp for this sheet first.')
    const result = await alerts.runSheet(settings)
    await deliverer.deliver()
    sendJson(res, 200, { ok: true, ...result })
  }

  async function simulate(req: IncomingMessage, res: ServerResponse) {
    const userId = await user(req)
    const { store, conversation, deliverer } = ready()
    if (config.provider.kind !== 'simulator') throw new HttpError(404, 'The test chat is only available in simulator mode.')
    const body = (await readJsonBody(req, BODY_LIMIT)) as { phone?: unknown; text?: unknown }
    const text = typeof body.text === 'string' ? body.text.slice(0, 2000) : ''
    if (!text.trim()) throw new HttpError(400, 'Type a message.')
    const own = await store.linkByUser(userId)
    const phone = typeof body.phone === 'string' && body.phone.trim() ? normalizePhone(body.phone) : (own?.phone ?? null)
    if (!phone) throw new HttpError(400, 'Enter the phone number to send from (with the country code).')
    const linked = await store.linkByPhone(phone)
    const owners = await store.contactOwnersOfPhone(phone)
    const mine = linked ? linked.userId === userId : owners.every((o) => o === userId)
    if (!mine) throw new HttpError(403, 'That number belongs to someone else.')
    await conversation.handle(phone, text, null)
    await deliverer.deliver()
    sendJson(res, 200, { ok: true, phone })
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (!pathname.startsWith('/api/whatsapp/')) return false
    const url = new URL(req.url ?? '/', 'http://localhost')
    try {
      const m = req.method ?? 'GET'
      let match: RegExpExecArray | null
      if (pathname === '/api/whatsapp/webhook' && m === 'GET') await webhookGet(req, res, url)
      else if (pathname === '/api/whatsapp/webhook' && m === 'POST') await webhookPost(req, res)
      else if (pathname === '/api/whatsapp/status' && m === 'GET') await status(req, res)
      else if (pathname === '/api/whatsapp/link' && m === 'POST') await link(req, res)
      else if (pathname === '/api/whatsapp/simulate' && m === 'POST') await simulate(req, res)
      else if ((match = /^\/api\/whatsapp\/contacts\/([^/]+)\/invite$/.exec(pathname)) && m === 'POST') await invite(req, res, match[1])
      else if ((match = /^\/api\/whatsapp\/sheets\/([^/]+)\/summary$/.exec(pathname)) && m === 'POST') await summary(req, res, match[1])
      else if ((match = /^\/api\/whatsapp\/sheets\/([^/]+)\/check$/.exec(pathname)) && m === 'POST') await check(req, res, match[1])
      else throw new HttpError(404, 'Not found.')
    } catch (err) {
      if (res.headersSent) return true
      if (err instanceof HttpError) sendJson(res, err.status, { ok: false, error: err.message }, err.headers)
      else {
        log('whatsapp.route.failed', { path: pathname, error: (err as Error).message })
        sendJson(res, 500, { ok: false, error: 'Something went wrong.' })
      }
    }
    return true
  }
}
