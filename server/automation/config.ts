/**
 * Automation server settings, read from the environment. Nothing secret has a default and nothing
 * here is ever sent to the browser.
 *
 *   SUPABASE_SERVICE_ROLE_KEY        enables time based rules, digests, update requests and approvals.
 *                                    Server only; never prefix it with VITE_ (scripts/check-bundle.mjs
 *                                    fails the build if the browser bundle contains the name).
 *   RESEND_API_KEY + MAIL_FROM       send real e-mail through Resend; without them e-mail is simulated
 *                                    (it is written to the owner's notification centre instead).
 *   PUBLIC_APP_URL                   the address people open the app at (links in e-mails), e.g. https://app.example.com
 *   AUTOMATION_TICK_SECONDS          how often the scheduler looks for work (default 60)
 *   AUTOMATION_EMAIL_PER_DAY         e-mails one owner may send per day (default 100)
 *   AUTOMATION_EMAIL_ALLOW_ANONYMOUS true to let anonymous visitors send real e-mail (default false)
 */
export interface AutomationConfig {
  supabaseUrl: string
  serviceRoleKey: string
  publicUrl: string
  mail: { kind: 'resend'; apiKey: string; from: string } | { kind: 'simulator' }
  tickMs: number
  emailPerOwnerPerDay: number
  allowAnonymousEmail: boolean
}

type Env = Record<string, string | undefined>

/** The settings, or null (with the reason) when the server cannot do automation. */
export function readAutomationConfig(env: Env): { config: AutomationConfig } | { config: null; reason: string } {
  const supabaseUrl = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').trim()
  const serviceRoleKey = (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (!serviceRoleKey) return { config: null, reason: 'SUPABASE_SERVICE_ROLE_KEY is not set: time based rules, digests, update requests and approvals are off (in-app notifications still work).' }
  if (!supabaseUrl) return { config: null, reason: 'SUPABASE_URL is not set: automation on the server is off.' }
  const key = (env.RESEND_API_KEY ?? '').trim()
  const from = (env.MAIL_FROM ?? '').trim()
  const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
  return {
    config: {
      supabaseUrl,
      serviceRoleKey,
      publicUrl: (env.PUBLIC_APP_URL ?? '').trim().replace(/\/+$/, ''),
      mail: key && from ? { kind: 'resend', apiKey: key, from } : { kind: 'simulator' },
      tickMs: num(env.AUTOMATION_TICK_SECONDS, 60) * 1000,
      emailPerOwnerPerDay: num(env.AUTOMATION_EMAIL_PER_DAY, 100),
      allowAnonymousEmail: env.AUTOMATION_EMAIL_ALLOW_ANONYMOUS === 'true',
    },
  }
}
