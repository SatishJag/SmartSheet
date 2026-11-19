/**
 * Wires the WhatsApp assistant from the environment: the service-role store, the provider (Meta Cloud
 * API or the simulator), the conversation, the outbox, the alerts job and the HTTP routes. Without
 * SUPABASE_SERVICE_ROLE_KEY the routes answer 503 and nothing runs.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AnthropicLike } from '../ai'
import { createUserVerifier } from '../automation'
import { createResendMailer } from '../automation/mailer'
import type { Logger } from '../log'
import { createAlerts } from './alerts'
import { readWhatsAppConfig, type WhatsAppConfig } from './config'
import { createConversation } from './conversation'
import { createDeliverer } from './outbox'
import { createMetaProvider, createSimulatorProvider, type WhatsAppProvider } from './provider'
import { createWhatsAppRoutes } from './routes'
import { createSupabaseWhatsAppStore, type WhatsAppStore } from './store'

export interface WhatsApp {
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean>
  /** Delivers due messages, sends rule messages and runs due sheet alerts. */
  tick(): Promise<void>
  start(): void
  stop(): void
  config: WhatsAppConfig
}

export interface WhatsAppOverrides {
  store?: WhatsAppStore
  serviceClient?: SupabaseClient
  provider?: WhatsAppProvider
  now?: () => number
  authenticate?: (token: string) => Promise<{ userId: string } | null>
  sendEmail?: ((to: string, subject: string, text: string) => Promise<boolean>) | null
  tickMs?: number
}

const serverAuth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const

export function createWhatsApp(env: Record<string, string | undefined>, log: Logger, ai: { client: AnthropicLike; model: string } | null, overrides: WhatsAppOverrides = {}): WhatsApp {
  const { config, warnings } = readWhatsAppConfig(env)
  for (const w of warnings) log('config.warning', { message: w })
  const url = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').trim()
  const anonKey = (env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || '').trim()
  const serviceKey = (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  const authenticate = overrides.authenticate ?? (url && anonKey ? createUserVerifier(url, anonKey) : null)
  const now = overrides.now ?? Date.now

  let store: WhatsAppStore | null = overrides.store ?? null
  if (!store && (overrides.serviceClient || (url && serviceKey))) {
    store = createSupabaseWhatsAppStore(overrides.serviceClient ?? createClient(url, serviceKey, { auth: serverAuth }))
  }
  if (!store) {
    const reason = 'SUPABASE_SERVICE_ROLE_KEY is not set: the WhatsApp assistant is off.'
    log('config.warning', { message: reason })
    const routes = createWhatsAppRoutes({ config, store: null, conversation: null, alerts: null, deliverer: null, disabledReason: reason, authenticate, ai: false, now, log })
    return { handle: routes, tick: async () => {}, start() {}, stop() {}, config }
  }

  const provider = overrides.provider ?? (config.provider.kind === 'meta' ? createMetaProvider(config.provider) : createSimulatorProvider())
  let sendEmail = overrides.sendEmail
  if (sendEmail === undefined) {
    const key = (env.RESEND_API_KEY ?? '').trim()
    const from = (env.MAIL_FROM ?? '').trim()
    if (key && from) {
      const mailer = createResendMailer({ apiKey: key, from })
      sendEmail = async (to, subject, text) => {
        try {
          await mailer.send({ to, subject, text })
          return true
        } catch (err) {
          log('whatsapp.email.failed', { error: (err as Error).message })
          return false
        }
      }
    } else sendEmail = null
  }
  const conversation = createConversation({ store, now, log, ai, sendEmail })
  const deliverer = createDeliverer({ store, provider, config, now, log })
  const alerts = createAlerts({ store, conversation, now, log, alertEveryMs: config.alertEveryMs })
  const routes = createWhatsAppRoutes({ config, store, conversation, alerts, deliverer, authenticate, ai: ai !== null, now, log })

  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  async function tick() {
    if (running) return
    running = true
    try {
      const rules = await alerts.ruleMessages().catch((err) => (log('whatsapp.rules.failed', { error: (err as Error).message }), 0))
      const queued = await alerts.run().catch((err) => (log('whatsapp.alerts.failed', { error: (err as Error).message }), 0))
      const out = await deliverer.deliver().catch((err) => (log('whatsapp.deliver.failed', { error: (err as Error).message }), { sent: 0, skipped: 0, failed: 0 }))
      if (rules || queued || out.sent || out.failed) log('whatsapp.tick', { rules, queued, ...out })
    } finally {
      running = false
    }
  }
  log('whatsapp.ready', { mode: provider.kind, template: config.template !== null, ai: ai !== null })
  return {
    handle: routes,
    tick,
    start() {
      if (timer) return
      timer = setInterval(() => void tick(), overrides.tickMs ?? 30_000)
      timer.unref()
      setTimeout(() => void tick(), 8_000).unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    config,
  }
}
