/**
 * Wires the automation server from the environment: the service-role store, the mailer, the request
 * service, the scheduler and the HTTP routes. Without SUPABASE_SERVICE_ROLE_KEY everything that needs
 * the database as the server (time based rules, digests, update requests, approvals) is off and says
 * so; the app itself (in-app notifications from the browser) is unaffected.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '../log'
import { readAutomationConfig, type AutomationConfig } from './config'
import { createResendMailer, createSimulatorMailer, type Mailer } from './mailer'
import { createOutbound } from './outbound'
import { createRequestService } from './requests'
import { createAutomationRoutes } from './routes'
import { createScheduler, type Scheduler } from './scheduler'
import { createSupabaseStore, type AutomationStore } from './store'

export interface Automation {
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean>
  scheduler: Scheduler | null
  config: AutomationConfig | null
}

const serverAuth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const

/** Verifies a user's access token (4xx = invalid token, anything else = verification failed). */
export function createUserVerifier(url: string, anonKey: string): (token: string) => Promise<{ userId: string } | null> {
  const authClient = createClient(url, anonKey, { auth: serverAuth })
  return async (token) => {
    const { data, error } = await authClient.auth.getUser(token)
    if (error) {
      if (typeof error.status === 'number' && error.status >= 400 && error.status < 500) return null
      throw new Error(`Supabase auth check failed: ${error.name} ${error.status ?? ''}`.trim())
    }
    return data.user ? { userId: data.user.id } : null
  }
}

export interface AutomationOverrides {
  /** Tests inject a service-role client, a mailer and a clock. */
  serviceClient?: SupabaseClient
  mailer?: Mailer
  now?: () => number
  trustProxy?: boolean
  authenticate?: (token: string) => Promise<{ userId: string } | null>
  limits?: { publicPerMinute?: number; failuresPer10Minutes?: number; createPerHourPerUser?: number }
}

export function createAutomation(env: Record<string, string | undefined>, log: Logger, overrides: AutomationOverrides = {}): Automation {
  const anonKey = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const authenticate = overrides.authenticate ?? (url && anonKey ? createUserVerifier(url, anonKey) : null)
  const trustProxy = overrides.trustProxy ?? (env.TRUST_PROXY === 'true' || Boolean(env.RAILWAY_ENVIRONMENT))
  const read = readAutomationConfig(env)

  if (!read.config && !overrides.serviceClient) {
    log('config.warning', { message: read.config === null ? read.reason : '' })
    const routes = createAutomationRoutes({ authenticate, store: null, requests: null, mailer: createSimulatorMailer(), disabledReason: read.config === null ? read.reason : undefined, log, trustProxy, limits: overrides.limits })
    return { handle: routes, scheduler: null, config: null }
  }

  const config: AutomationConfig = read.config ?? { supabaseUrl: url ?? '', serviceRoleKey: '', publicUrl: '', mail: { kind: 'simulator' }, tickMs: 60_000, emailPerOwnerPerDay: 100, allowAnonymousEmail: false }
  const db = overrides.serviceClient ?? createClient(config.supabaseUrl, config.serviceRoleKey, { auth: serverAuth })
  const store: AutomationStore = createSupabaseStore(db)
  const mailer = overrides.mailer ?? (config.mail.kind === 'resend' ? createResendMailer({ apiKey: config.mail.apiKey, from: config.mail.from }) : createSimulatorMailer())
  const now = overrides.now ?? Date.now
  const outbound = createOutbound({ config, mailer, store, now, log })
  const requests = createRequestService({ store, outbound, config, now, log })
  const scheduler = createScheduler({ store, outbound, requests, config, now, log })
  const routes = createAutomationRoutes({ authenticate, store, requests, mailer, now, log, trustProxy, limits: overrides.limits })
  log('automation.ready', { mail: mailer.kind, tickSeconds: config.tickMs / 1000, publicUrl: Boolean(config.publicUrl) })
  return { handle: routes, scheduler, config }
}
