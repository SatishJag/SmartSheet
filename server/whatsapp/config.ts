/**
 * WhatsApp settings, read from the environment (server only; nothing here reaches the browser).
 *
 *   WHATSAPP_ACCESS_TOKEN        Meta WhatsApp Cloud API token (a system-user token for production)
 *   WHATSAPP_PHONE_NUMBER_ID     the sender's phone number id (Meta > WhatsApp > API setup)
 *   WHATSAPP_APP_SECRET          the Meta app secret: every webhook POST must carry a valid X-Hub-Signature-256
 *   WHATSAPP_VERIFY_TOKEN        any string; the same value goes into Meta's webhook settings
 *   WHATSAPP_BUSINESS_NUMBER     the sender's number with country code (for wa.me links), e.g. 971501234567
 *   WHATSAPP_TEMPLATE_NAME       optional: an approved template with one body parameter, used for messages
 *                                outside WhatsApp's 24-hour service window (alerts, summaries)
 *   WHATSAPP_TEMPLATE_LANG       its language code (default en)
 *   WHATSAPP_MESSAGES_PER_DAY    outbound messages per account per day (default 300)
 *   WHATSAPP_ALERT_MINUTES       how often each sheet is checked for alerts (default 15)
 *   WHATSAPP_GRAPH_VERSION       Graph API version (default v21.0)
 *
 * Without the token and phone number id the assistant runs as a simulator: messages are stored and
 * shown in the app (WhatsApp page) but not sent, and the page's test chat plays the phone.
 */
export interface WhatsAppConfig {
  provider: { kind: 'meta'; accessToken: string; phoneNumberId: string; graphVersion: string } | { kind: 'simulator' }
  appSecret: string
  verifyToken: string
  businessNumber: string
  template: { name: string; lang: string } | null
  perOwnerPerDay: number
  alertEveryMs: number
  publicUrl: string
}

type Env = Record<string, string | undefined>

export function readWhatsAppConfig(env: Env): { config: WhatsAppConfig; warnings: string[] } {
  const v = (k: string) => (env[k] ?? '').trim()
  const num = (k: string, d: number) => (Number.isFinite(Number(env[k])) && Number(env[k]) > 0 ? Number(env[k]) : d)
  const warnings: string[] = []
  const accessToken = v('WHATSAPP_ACCESS_TOKEN')
  const phoneNumberId = v('WHATSAPP_PHONE_NUMBER_ID')
  const appSecret = v('WHATSAPP_APP_SECRET')
  let provider: WhatsAppConfig['provider'] = { kind: 'simulator' }
  if (accessToken && phoneNumberId) {
    if (!appSecret) warnings.push('WHATSAPP_APP_SECRET is not set: the webhook refuses every message until it is (signatures cannot be checked).')
    provider = { kind: 'meta', accessToken, phoneNumberId, graphVersion: v('WHATSAPP_GRAPH_VERSION') || 'v21.0' }
  } else if (accessToken || phoneNumberId) {
    warnings.push('Set both WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID to send real WhatsApp messages; running as a simulator.')
  }
  if (provider.kind === 'meta' && !v('WHATSAPP_BUSINESS_NUMBER')) warnings.push('WHATSAPP_BUSINESS_NUMBER is not set: link codes cannot offer a wa.me link.')
  const templateName = v('WHATSAPP_TEMPLATE_NAME')
  return {
    config: {
      provider,
      appSecret,
      verifyToken: v('WHATSAPP_VERIFY_TOKEN'),
      businessNumber: v('WHATSAPP_BUSINESS_NUMBER').replace(/[^0-9]/g, ''),
      template: templateName ? { name: templateName, lang: v('WHATSAPP_TEMPLATE_LANG') || 'en' } : null,
      perOwnerPerDay: num('WHATSAPP_MESSAGES_PER_DAY', 300),
      alertEveryMs: num('WHATSAPP_ALERT_MINUTES', 15) * 60_000,
      publicUrl: v('PUBLIC_APP_URL').replace(/\/+$/, ''),
    },
    warnings,
  }
}
