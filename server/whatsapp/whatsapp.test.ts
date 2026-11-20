// @vitest-environment node
import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MEENA, RAVI, WCOL, waSheet } from '../../src/whatsapp/__fixtures__/sheet'
import type { AnthropicLike } from '../ai'
import { createAlerts } from './alerts'
import type { WhatsAppConfig } from './config'
import { createConversation, hashCode } from './conversation'
import { createMemoryStore } from './memoryStore'
import { createDeliverer, notBefore, queue } from './outbox'
import { parseWebhook, ProviderError, verifySignature, type WhatsAppProvider } from './provider'
import { createWhatsAppRoutes } from './routes'
import type { SheetSettings } from './store'

const OWNER = 'owner-1'
const OWNER_PHONE = '971500000001'
const RAVI_PHONE = '971500000002'
const MEENA_PHONE = '971500000003'
const STRANGER = '971500000009'
const silent = () => {}

let clock = Date.parse('2026-11-19T10:00:00Z')
const now = () => clock

function fakeProvider(kind: 'meta' | 'simulator' = 'simulator') {
  const sent: { to: string; body: string; template: boolean }[] = []
  let fail: Error | null = null
  const p: WhatsAppProvider & { sent: typeof sent; failWith(e: Error | null): void } = {
    kind,
    sent,
    failWith: (e) => {
      fail = e
    },
    async sendText(to, body) {
      if (fail) throw fail
      sent.push({ to, body, template: false })
      return `wamid.${sent.length}`
    },
    async sendTemplate(to, _t, param) {
      if (fail) throw fail
      sent.push({ to, body: param, template: true })
      return `wamid.${sent.length}`
    },
  }
  return p
}

function settings(over: Partial<SheetSettings> = {}): SheetSettings {
  return { sheetId: 'sheet-wa', ownerId: OWNER, enabled: true, delayAlerts: true, nudges: true, reminderHours: 24, maxReminders: 2, dailySummary: true, summaryHour: 8, timeZone: 'UTC', dndStart: '22:00', dndEnd: '07:00', ownerColumnId: null, ...over }
}

function setup(opts: { ai?: AnthropicLike | null } = {}) {
  const store = createMemoryStore(now)
  store.state.sheets.set('sheet-wa', waSheet())
  store.state.accounts.set(OWNER, { email: 'pm@builder.example', anonymous: false })
  store.state.links.push({ userId: OWNER, email: 'pm@builder.example', phone: OWNER_PHONE })
  store.state.contacts.push(
    { id: 'c-ravi', ownerId: OWNER, name: 'Ravi (Concrete)', email: RAVI, phone: RAVI_PHONE, status: 'active' },
    { id: 'c-meena', ownerId: OWNER, name: 'Meena (Steel)', email: MEENA, phone: MEENA_PHONE, status: 'active' },
  )
  const mails: { to: string; subject: string; text: string }[] = []
  const conversation = createConversation({
    store,
    now,
    log: silent,
    ai: opts.ai ? { client: opts.ai, model: 'claude-opus-5-5' } : null,
    sendEmail: async (to, subject, text) => {
      mails.push({ to, subject, text })
      return true
    },
  })
  const provider = fakeProvider()
  const deliverer = createDeliverer({ store, provider, config: { template: null, perOwnerPerDay: 300 }, now, log: silent })
  const alerts = createAlerts({ store, conversation, now, log: silent, alertEveryMs: 15 * 60_000 })
  const say = async (phone: string, text: string) => {
    await conversation.handle(phone, text, null)
    const out = store.outbound(phone)
    return out[out.length - 1]?.body ?? ''
  }
  const cell = (rowId: string, col: string) => store.state.sheets.get('sheet-wa')!.rows.find((r) => r.id === rowId)!.cells[col]
  return { store, conversation, provider, deliverer, alerts, say, cell, mails }
}

beforeEach(() => {
  clock = Date.parse('2026-11-19T10:00:00Z')
})

describe('linking and joining', () => {
  it('a LINK code binds the sending phone to the account, once', async () => {
    const { store, say } = setup()
    store.state.links = []
    store.state.accounts.set('user-2', { email: 'site@builder.example', anonymous: false })
    await store.createCode({ hash: hashCode('ABCD2345'), kind: 'link', userId: 'user-2', expiresAt: clock + 60_000 })
    expect(await say(STRANGER, 'link abcd2345')).toContain('now linked')
    expect(store.state.links).toEqual([{ userId: 'user-2', email: 'site@builder.example', phone: STRANGER }])
    expect(await say('971500000010', 'LINK ABCD2345')).toContain('not valid')
  })

  it('an expired code does not link', async () => {
    const { store, say } = setup()
    await store.createCode({ hash: hashCode('ZZZZ2345'), kind: 'link', userId: 'user-3', expiresAt: clock - 1 })
    expect(await say(STRANGER, 'LINK ZZZZ2345')).toContain('not valid')
  })

  it('a JOIN code activates the contact only from the invited number', async () => {
    const { store, say } = setup()
    store.state.contacts.push({ id: 'c-new', ownerId: OWNER, name: 'Omar', email: 'omar@sub.example', phone: '971500000004', status: 'invited' })
    await store.createCode({ hash: hashCode('JOIN2345'), kind: 'join', contactId: 'c-new', expiresAt: clock + 60_000 })
    expect(await say(STRANGER, 'JOIN JOIN2345')).toContain('different phone number')
    await store.createCode({ hash: hashCode('JOIN6789'), kind: 'join', contactId: 'c-new', expiresAt: clock + 60_000 })
    expect(await say('971500000004', 'JOIN JOIN6789')).toContain('Welcome, Omar')
    expect(store.state.contacts.find((c) => c.id === 'c-new')!.status).toBe('active')
  })

  it('an unknown number is told how to link, once a day', async () => {
    const { store, say } = setup()
    expect(await say(STRANGER, 'hello')).toContain('not linked')
    await say(STRANGER, 'hello again')
    expect(store.outbound(STRANGER)).toHaveLength(1)
    clock += 25 * 3_600_000
    await say(STRANGER, 'hello?')
    expect(store.outbound(STRANGER)).toHaveLength(2)
  })
})

describe('the owner’s menu', () => {
  it('shows the menu, lists delayed work, details and updates a task', async () => {
    const { say, cell } = setup()
    const menu = await say(OWNER_PHONE, 'Hi')
    expect(menu).toContain('*Tower A*')
    expect(menu).toContain('Delayed: 2')
    const list = await say(OWNER_PHONE, '1')
    expect(list).toMatch(/\*1\.\* Rebar delivery[\s\S]*\*2\.\* Pour slab L1/)
    expect(await say(OWNER_PHONE, '#2')).toContain('Forecast finish at this rate: 2026-11-22')
    const done = await say(OWNER_PHONE, '2 complete - poured this morning')
    expect(done).toContain('Row 3 *Pour slab L1*')
    expect(cell('r-slab', WCOL.status)).toBe('Complete')
    expect(cell('r-slab', WCOL.percent)).toBe(100)
    expect(cell('r-slab', WCOL.comments)).toBe('2026-11-19 pm: poured this morning')
    expect(await say(OWNER_PHONE, '1 60%')).toContain('60% complete')
    expect(cell('r-rebar', WCOL.percent)).toBe(60)
  })

  it('refuses an unknown status and a locked row, and explains', async () => {
    const { store, say } = setup()
    await say(OWNER_PHONE, '1')
    expect(await say(OWNER_PHONE, '1 banana')).toContain('Use one of: Not started, In progress, On hold, Complete')
    store.state.locks.add('r-rebar')
    expect(await say(OWNER_PHONE, '1 Complete')).toContain('locked')
  })

  it('offers a picker with several sheets and keeps the choice', async () => {
    const { store, say } = setup()
    const other = waSheet()
    store.state.sheets.set('sheet-2', { ...other, sheet: { ...other.sheet, id: 'sheet-2', name: 'Villa B' }, rows: [] })
    const pick = await say(OWNER_PHONE, 'hello')
    expect(pick).toContain('Pick a project')
    expect(await say(OWNER_PHONE, '1')).toContain('*Tower A*')
    expect(await say(OWNER_PHONE, '5')).toContain('Topping out')
    expect(await say(OWNER_PHONE, '0')).toContain('Pick a project')
  })

  it('sends delay reminders to task owners (option 6) and lets them answer from that list', async () => {
    const { store, say, cell } = setup()
    await say(OWNER_PHONE, 'menu')
    const report = await say(OWNER_PHONE, '6')
    expect(report).toContain('Sent to: ')
    expect(report).toContain('Meena (Steel) (1)')
    expect(store.outbound(MEENA_PHONE)[0].body).toContain('Rebar delivery')
    expect(await say(OWNER_PHONE, '6')).toContain('Already reminded today')
    expect(await say(MEENA_PHONE, '1 In progress - truck arrives Friday')).toContain('In progress')
    expect(cell('r-rebar', WCOL.status)).toBe('In progress')
    expect(store.state.inApp.at(-1)!.title).toBe('Meena (Steel) updated “Rebar delivery” on WhatsApp')
  })

  it('e-mails the full last list', async () => {
    const { say, mails } = setup()
    await say(OWNER_PHONE, 'menu')
    await say(OWNER_PHONE, '2')
    expect(await say(OWNER_PHONE, 'EMAIL')).toContain('pm@builder.example')
    expect(mails[0].text).toContain('Columns L2')
  })
})

describe('site contacts', () => {
  it('see and update only their own tasks, in WhatsApp-enabled sheets', async () => {
    const { store, say, cell } = setup()
    expect(await say(RAVI_PHONE, 'tasks')).toContain('no open tasks')
    store.state.settings.set('sheet-wa', settings())
    const mine = await say(RAVI_PHONE, 'tasks')
    expect(mine).toMatch(/\*1\.\* Pour slab L1 \(Tower A\)[\s\S]*\*2\.\* Columns L2 \(Tower A\)/)
    expect(mine).not.toContain('Rebar')
    expect(await say(RAVI_PHONE, '2 25%')).toContain('25% complete')
    expect(cell('r-col', WCOL.percent)).toBe(25)
    // A list that somehow points at someone else's task is refused.
    const sess = await store.session(RAVI_PHONE)
    await store.saveSession(RAVI_PHONE, { ...sess.state, list: { title: 'x', items: [{ sheetId: 'sheet-wa', rowId: 'r-rebar' }], at: clock } })
    expect(await say(RAVI_PHONE, '1 Complete')).toContain('only update tasks you are responsible for')
    expect(cell('r-rebar', WCOL.status)).toBe('Not started')
    expect(await say(RAVI_PHONE, 'what is going on')).toContain('reply *TASKS*')
  })
})

describe('STOP / START and delivery', () => {
  it('honours STOP for everything but the confirmation', async () => {
    const { store, say, deliverer, provider } = setup()
    await say(OWNER_PHONE, 'STOP')
    await queue(store, { ownerId: OWNER, phone: OWNER_PHONE, body: 'alert', kind: 'alert', priority: 'HIGH' }, clock)
    await deliverer.deliver()
    expect(provider.sent.map((s) => s.body)).toEqual(['You will not get any more messages from this number. Reply *START* to resume.'])
    expect(store.outbound(OWNER_PHONE).at(-1)!.status).toBe('skipped')
    expect(await say(OWNER_PHONE, 'menu')).toContain('Messages are off')
    await say(OWNER_PHONE, 'START')
    expect(await store.isOptedOut(OWNER_PHONE)).toBe(false)
  })

  it('uses the template outside the 24-hour window, skips without one, retries transient errors', async () => {
    const store = createMemoryStore(now)
    const provider = fakeProvider('meta')
    const withTemplate = createDeliverer({ store, provider, config: { template: { name: 'planner_update', lang: 'en' }, perOwnerPerDay: 300 }, now, log: silent })
    await queue(store, { ownerId: OWNER, phone: RAVI_PHONE, body: 'Line one\nLine two', kind: 'alert', priority: 'MEDIUM' }, clock)
    await withTemplate.deliver()
    expect(provider.sent).toEqual([{ to: RAVI_PHONE, body: 'Line one · Line two', template: true }])

    await store.saveSession(MEENA_PHONE, {}, clock - 3_600_000)
    await queue(store, { ownerId: OWNER, phone: MEENA_PHONE, body: 'In window', kind: 'reply', priority: 'HIGH' }, clock)
    await withTemplate.deliver()
    expect(provider.sent.at(-1)).toEqual({ to: MEENA_PHONE, body: 'In window', template: false })

    const noTemplate = createDeliverer({ store, provider, config: { template: null, perOwnerPerDay: 300 }, now, log: silent })
    await queue(store, { ownerId: OWNER, phone: STRANGER, body: 'Outside', kind: 'alert', priority: 'MEDIUM' }, clock)
    await noTemplate.deliver()
    expect(store.outbound(STRANGER)[0]).toMatchObject({ status: 'skipped' })

    provider.failWith(new ProviderError('busy', true))
    await queue(store, { ownerId: OWNER, phone: MEENA_PHONE, body: 'Retry me', kind: 'reply', priority: 'HIGH' }, clock)
    await noTemplate.deliver()
    const m = store.outbound(MEENA_PHONE).at(-1)!
    expect(m).toMatchObject({ status: 'pending', attempts: 1, nextAttemptAt: clock + 60_000 })
    provider.failWith(new ProviderError('invalid number', false))
    clock += 61_000
    await noTemplate.deliver()
    expect(store.outbound(MEENA_PHONE).at(-1)).toMatchObject({ status: 'failed', attempts: 2 })
  })

  it('stops at the daily cap per account', async () => {
    const store = createMemoryStore(now)
    const provider = fakeProvider('meta')
    const d = createDeliverer({ store, provider, config: { template: { name: 't', lang: 'en' }, perOwnerPerDay: 2 }, now, log: silent })
    for (let i = 0; i < 3; i++) await queue(store, { ownerId: OWNER, phone: RAVI_PHONE, body: `m${i}`, kind: 'alert', priority: 'MEDIUM' }, clock)
    await d.deliver()
    expect(provider.sent).toHaveLength(2)
    expect(store.outbound().at(-1)!.error).toContain('daily limit of 2')
  })

  it('defers routine messages in quiet hours, not HIGH ones', () => {
    const night = Date.parse('2026-11-19T23:00:00Z')
    const q = { timeZone: 'UTC', dndStart: '22:00', dndEnd: '07:00' }
    expect(notBefore(night, 'HIGH', q)).toBe(night)
    expect(notBefore(night, 'MEDIUM', q)).toBe(Date.parse('2026-11-20T07:00:00Z'))
    expect(notBefore(Date.parse('2026-11-19T12:00:00Z'), 'LOW', q)).toBe(Date.parse('2026-11-19T12:00:00Z'))
  })

  it('splits long text into WhatsApp-sized parts with their own dedup keys', async () => {
    const store = createMemoryStore(now)
    const body = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
    expect(await queue(store, { ownerId: OWNER, phone: RAVI_PHONE, body, kind: 'summary', priority: 'LOW', dedupKey: 'k' }, clock)).toBe(true)
    expect(store.outbound().length).toBeGreaterThan(1)
    expect(await queue(store, { ownerId: OWNER, phone: RAVI_PHONE, body, kind: 'summary', priority: 'LOW', dedupKey: 'k' }, clock)).toBe(false)
  })
})

describe('alerts', () => {
  it('alerts task owners once per finish date; answers 1-4 update the task', async () => {
    const { store, alerts, say, cell } = setup()
    store.state.settings.set('sheet-wa', settings())
    const r = await alerts.runSheet(settings())
    expect(r.alerts).toBe(2)
    expect(store.outbound(RAVI_PHONE)[0]).toMatchObject({ kind: 'alert', priority: 'HIGH' })
    expect(store.outbound(RAVI_PHONE)[0].body).toContain('Critical path task is late')
    expect(store.outbound(MEENA_PHONE)[0].priority).toBe('MEDIUM')
    expect(r.summary).toBe(true)
    expect(store.outbound(OWNER_PHONE).at(-1)!.body).toContain('📊 *Tower A* — 2026-11-19')
    const again = await alerts.runSheet(settings())
    expect(again).toEqual({ alerts: 0, nudges: 0, summary: false })
    expect(await say(RAVI_PHONE, '3')).toContain('status *Complete*')
    expect(cell('r-slab', WCOL.status)).toBe('Complete')
    expect(await say(MEENA_PHONE, '2 - supplier short of 16mm bar')).toContain('note added')
    expect(cell('r-rebar', WCOL.comments)).toBe('2026-11-19 Meena (Steel): supplier short of 16mm bar')
  })

  it('a menu choice after an alert is a menu choice, not an answer', async () => {
    const { store, alerts, say } = setup()
    await alerts.runSheet(settings({ dailySummary: false }))
    clock += 1000
    await say(OWNER_PHONE, 'menu')
    store.state.links.push({ userId: 'u-ravi', email: RAVI, phone: '971500000077' })
    expect(await say(OWNER_PHONE, '2')).toContain('Due in 30 days')
  })

  it('checks progress at 50 / 70 / 90 %, reminds, then reports no response', async () => {
    const { store, alerts, say } = setup()
    clock = Date.parse('2026-11-23T10:00:00Z') // Columns L2 is 7 of 11 days in, 0% reported
    const st = settings({ delayAlerts: false, dailySummary: false, reminderHours: 2, maxReminders: 1 })
    expect((await alerts.runSheet(st)).nudges).toBe(1)
    expect(store.outbound(RAVI_PHONE)[0].body).toContain('50% of the time has passed')
    expect((await alerts.runSheet(st)).nudges).toBe(0)
    clock += 3 * 3_600_000
    expect((await alerts.runSheet(st)).nudges).toBe(1)
    expect(store.outbound(RAVI_PHONE)[1].body).toContain('Reminder 1')
    clock += 3 * 3_600_000
    await alerts.runSheet(st)
    expect(store.state.nudges.find((n) => n.rowId === 'r-col')!.noResponseAt).not.toBeNull()
    expect(store.state.inApp.at(-1)!.title).toContain('No answer from Ravi (Concrete)')
    expect(store.outbound(OWNER_PHONE).at(-1)!.body).toContain('No response to progress checks')
    // A later answer still works and marks the check answered.
    expect(await say(RAVI_PHONE, '60%')).toContain('60% complete')
  })

  it('delivers Automation rule messages to linked or joined recipients only', async () => {
    const { store, alerts } = setup()
    store.state.ruleMessages.push(
      { id: 'n1', ownerId: OWNER, sheetId: 'sheet-wa', rowId: 'r-slab', email: RAVI, title: 'Slab poured', body: 'Status: Complete', status: 'pending', error: null, deliverAfter: clock },
      { id: 'n2', ownerId: OWNER, sheetId: 'sheet-wa', rowId: null, email: 'nobody@else.example', title: 'x', body: '', status: 'pending', error: null, deliverAfter: clock },
      { id: 'n3', ownerId: OWNER, sheetId: null, rowId: null, email: 'PM@builder.example', title: 'For me', body: 'hi', status: 'pending', error: null, deliverAfter: clock },
    )
    expect(await alerts.ruleMessages()).toBe(2)
    expect(store.outbound(RAVI_PHONE)[0].body).toBe('*Slab poured*\n\nStatus: Complete')
    expect(store.outbound(OWNER_PHONE)[0].body).toContain('For me')
    expect(store.state.ruleMessages.map((m) => m.status)).toEqual(['sent', 'skipped', 'sent'])
  })
})

describe('AI questions', () => {
  function fakeAi(answer: string): AnthropicLike & { calls: unknown[] } {
    const calls: unknown[] = []
    return {
      calls,
      beta: {
        messages: {
          async create(body) {
            calls.push(body)
            return { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: answer }], usage: {} } as never
          },
        },
      },
    }
  }

  it('answers from the sheet data, and falls back to the menu on SHOW_MENU', async () => {
    const ai = fakeAi('• row 4: Rebar delivery — 8 days late')
    const { say } = setup({ ai })
    await say(OWNER_PHONE, 'menu')
    expect(await say(OWNER_PHONE, 'what is late on steel?')).toBe('• row 4: Rebar delivery — 8 days late')
    const body = ai.calls[0] as { system: string; messages: { content: string }[]; fallbacks?: string }
    expect(body.messages[0].content).toContain('4 | Rebar delivery | Substructure')
    expect(body.messages[0].content).toContain('QUESTION\nwhat is late on steel?')
    expect(body.fallbacks).toBe('default')

    const { say: say2 } = setup({ ai: fakeAi('SHOW_MENU') })
    await say2(OWNER_PHONE, 'menu')
    expect(await say2(OWNER_PHONE, 'tell me a joke')).toContain("I'm not sure what you need")
  })
})

describe('webhook', () => {
  const SECRET = 'app-secret'
  let server: Server
  let base: string
  let ctx: ReturnType<typeof setup>

  beforeEach(async () => {
    ctx = setup()
    const config: WhatsAppConfig = {
      provider: { kind: 'meta', accessToken: 't', phoneNumberId: '1', graphVersion: 'v21.0' },
      appSecret: SECRET,
      verifyToken: 'verify-me',
      businessNumber: '971500000100',
      template: null,
      perOwnerPerDay: 300,
      alertEveryMs: 60_000,
      publicUrl: '',
    }
    const handle = createWhatsAppRoutes({
      config,
      store: ctx.store,
      conversation: ctx.conversation,
      alerts: ctx.alerts,
      deliverer: ctx.deliverer,
      authenticate: async (token) => (token === 'good' ? { userId: OWNER } : null),
      ai: false,
      now,
      log: silent,
    })
    server = createServer((req, res) => {
      void handle(req, res, new URL(req.url ?? '/', 'http://x').pathname).then((done) => {
        if (!done) res.writeHead(404).end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise((r) => server.close(r))
  })

  const payload = (from: string, text: string, id: string) => ({ entry: [{ changes: [{ value: { messages: [{ from, id, timestamp: '1763546400', type: 'text', text: { body: text } }] } }] }] })
  const sign = (raw: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`

  it('answers Meta’s verify challenge only with the right token', async () => {
    expect(await (await fetch(`${base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`)).text()).toBe('12345')
    expect((await fetch(`${base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status).toBe(403)
  })

  it('refuses unsigned or wrongly signed posts, handles signed ones once', async () => {
    const raw = JSON.stringify(payload(OWNER_PHONE, 'menu', 'wamid.A'))
    expect((await fetch(`${base}/api/whatsapp/webhook`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json' } })).status).toBe(401)
    expect((await fetch(`${base}/api/whatsapp/webhook`, { method: 'POST', body: raw, headers: { 'x-hub-signature-256': sign(raw, 'wrong') } })).status).toBe(401)
    const ok = await fetch(`${base}/api/whatsapp/webhook`, { method: 'POST', body: raw, headers: { 'x-hub-signature-256': sign(raw) } })
    expect(ok.status).toBe(200)
    await new Promise((r) => setTimeout(r, 50))
    expect(ctx.store.outbound(OWNER_PHONE)[0].body).toContain('*Tower A*')
    await fetch(`${base}/api/whatsapp/webhook`, { method: 'POST', body: raw, headers: { 'x-hub-signature-256': sign(raw) } })
    await new Promise((r) => setTimeout(r, 50))
    expect(ctx.store.outbound(OWNER_PHONE)).toHaveLength(1)
  })

  it('gives a signed-in user a link code and refuses strangers', async () => {
    expect((await fetch(`${base}/api/whatsapp/link`, { method: 'POST' })).status).toBe(401)
    const res = await fetch(`${base}/api/whatsapp/link`, { method: 'POST', headers: { authorization: 'Bearer good' } })
    const body = (await res.json()) as { code: string; waLink: string }
    expect(body.code).toMatch(/^[A-Z2-9]{8}$/)
    expect(body.waLink).toBe(`https://wa.me/971500000100?text=LINK%20${body.code}`)
    expect(ctx.store.state.codes[0]).toMatchObject({ kind: 'link', userId: OWNER })
    const status = (await (await fetch(`${base}/api/whatsapp/status`, { headers: { authorization: 'Bearer good' } })).json()) as { linked: { masked: string }; mode: string }
    expect(status).toMatchObject({ mode: 'meta', linked: { masked: '+971 ••• 0001' } })
    expect((await fetch(`${base}/api/whatsapp/unlink`, { method: 'POST', headers: { authorization: 'Bearer good' } })).status).toBe(200)
    expect(ctx.store.state.links.find((l) => l.userId === OWNER)).toBeUndefined()
  })

  it('lets an anonymous (no e-mail) account link too: only phones that write first are ever messaged', async () => {
    ctx.store.state.accounts.set(OWNER, { email: null, anonymous: true })
    const res = await fetch(`${base}/api/whatsapp/link`, { method: 'POST', headers: { authorization: 'Bearer good' } })
    expect(res.status).toBe(200)
  })

  it('invites only the caller’s own contacts', async () => {
    ctx.store.state.contacts.push({ id: '00000000-0000-0000-0000-00000000000a', ownerId: 'someone-else', name: 'X', email: 'x@x.example', phone: '971500000050', status: 'invited' })
    expect((await fetch(`${base}/api/whatsapp/contacts/00000000-0000-0000-0000-00000000000a/invite`, { method: 'POST', headers: { authorization: 'Bearer good' } })).status).toBe(404)
  })
})

describe('provider helpers', () => {
  it('parses Cloud API payloads and checks signatures', () => {
    const p = { entry: [{ changes: [{ value: { statuses: [{}] } }, { value: { messages: [{ from: '+971500000002', id: 'w1', timestamp: '1700000000', type: 'button', button: { text: 'Complete' } }, { from: '971', id: 'w2', type: 'image' }] } }] }] }
    expect(parseWebhook(p)).toEqual([
      { from: '971500000002', id: 'w1', text: 'Complete', at: 1_700_000_000_000 },
      { from: '971', id: 'w2', text: '', at: expect.any(Number) },
    ])
    expect(parseWebhook(null)).toEqual([])
    const raw = Buffer.from('{"a":1}')
    const good = `sha256=${createHmac('sha256', 's').update(raw).digest('hex')}`
    expect(verifySignature(raw, good, 's')).toBe(true)
    expect(verifySignature(raw, good, '')).toBe(false)
    expect(verifySignature(raw, 'sha256=zz', 's')).toBe(false)
  })
})

describe('shared sheets (0017_sharing)', () => {
  const EDITOR = 'u-editor'
  const VIEWER = 'u-viewer'
  const EDITOR_PHONE = '971500000020'
  const VIEWER_PHONE = '971500000021'

  function shared() {
    const ctx = setup()
    ctx.store.state.accounts.set(EDITOR, { email: 'qs@builder.example', anonymous: false })
    ctx.store.state.accounts.set(VIEWER, { email: 'client@owner.example', anonymous: false })
    ctx.store.state.links.push({ userId: EDITOR, email: 'qs@builder.example', phone: EDITOR_PHONE }, { userId: VIEWER, email: 'client@owner.example', phone: VIEWER_PHONE })
    ctx.store.state.members.push({ sheetId: 'sheet-wa', userId: EDITOR, role: 'editor' }, { sheetId: 'sheet-wa', userId: VIEWER, role: 'viewer' })
    return ctx
  }

  it('an editor gets the full menu of a shared sheet and can update its tasks; the owner is told', async () => {
    const { store, say, cell } = shared()
    const menu = await say(EDITOR_PHONE, 'menu')
    expect(menu).toContain('*Tower A* _(shared with you)_')
    expect(menu).toContain('*6*')
    expect(await say(EDITOR_PHONE, '1')).toContain('Update one: reply with its number')
    expect(await say(EDITOR_PHONE, '1 Complete - delivered today')).toContain('Row 4 *Rebar delivery*')
    expect(cell('r-rebar', WCOL.status)).toBe('Complete')
    expect(store.state.inApp.at(-1)).toMatchObject({ ownerId: OWNER, title: 'qs@builder.example updated “Rebar delivery” on WhatsApp' })
    expect(await say(EDITOR_PHONE, '6')).toContain('Delay reminders — Tower A')
  })

  it('a viewer can browse, see details and ask, but not update or send reminders', async () => {
    const { say, cell } = shared()
    const menu = await say(VIEWER_PHONE, 'hi')
    expect(menu).toContain('_(shared with you · view only)_')
    expect(menu).not.toContain('*6*')
    const list = await say(VIEWER_PHONE, '1')
    expect(list).toContain('*1.* Rebar delivery')
    expect(list).not.toContain('Update one')
    expect(await say(VIEWER_PHONE, '#2')).toContain('*Pour slab L1*')
    expect(await say(VIEWER_PHONE, '1 Complete')).toBe('This sheet is shared with you to view only, so you cannot change its tasks.')
    expect(cell('r-rebar', WCOL.status)).toBe('Not started')
    expect(await say(VIEWER_PHONE, '6')).toContain('view only')
  })

  it('a viewer who owns a task (their e-mail in the owner column) may still update that task', async () => {
    const { store, say, cell } = shared()
    store.state.links = store.state.links.map((l) => (l.userId === VIEWER ? { ...l, email: MEENA } : l))
    await say(VIEWER_PHONE, 'menu')
    await say(VIEWER_PHONE, '1')
    expect(await say(VIEWER_PHONE, '1 60%')).toContain('60% complete')
    expect(cell('r-rebar', WCOL.percent)).toBe(60)
    expect(await say(VIEWER_PHONE, '2 Complete')).toContain('view only') // the slab is Ravi's
  })

  it('lists own and shared sheets in the picker, and forgets a sheet whose access was removed', async () => {
    const { store, say } = shared()
    const own = waSheet()
    store.state.sheets.set('sheet-own', { ...own, sheet: { ...own.sheet, id: 'sheet-own', name: 'Villa B', ownerId: EDITOR }, rows: [] })
    const pick = await say(EDITOR_PHONE, 'menu')
    expect(pick).toContain('*1* Villa B\n*2* Tower A _(shared)_')
    expect(await say(EDITOR_PHONE, '2')).toContain('*Tower A* _(shared with you)_')
    expect(await say(EDITOR_PHONE, '1')).toContain('Rebar delivery')
    store.state.members = store.state.members.filter((m) => m.userId !== EDITOR)
    // The list from the shared sheet no longer opens, and the sheet itself is forgotten.
    expect(await say(EDITOR_PHONE, '#1')).toBe('That task is not one of yours.')
    expect(await say(EDITOR_PHONE, '1 Complete')).toBe('You can only update tasks you are responsible for.')
    expect(await say(EDITOR_PHONE, '1')).toContain('*Villa B — Delayed*') // the only sheet left opens
  })
})

describe('the Supabase store reads roles and shared sheets like 0017_sharing', () => {
  it('lists own then shared sheets with the role, and answers sheetRole', async () => {
    const { createFakeSupabase } = await import('../../e2e/support/fakeSupabase')
    const { createSupabaseWhatsAppStore } = await import('./store')
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    const user = createFakeSupabase({ storage })
    const b = (await user.auth.signUp({ email: 'b@example.com', password: 'pw-b-123456' })).data.user!.id
    await user.auth.signOut()
    const a = (await user.auth.signUp({ email: 'a@example.com', password: 'pw-a-123456' })).data.user!.id
    const sheet = ((await user.from('sheets').insert({ name: 'Tower A' }).select('id').single()).data as { id: string }).id
    const other = ((await user.from('sheets').insert({ name: 'Private' }).select('id').single()).data as { id: string }).id
    expect((await user.rpc('share_sheet', { p_sheet: sheet, p_email: 'b@example.com', p_role: 'editor' })).error).toBeNull()
    await user.auth.signOut()
    await user.auth.signInWithPassword({ email: 'b@example.com', password: 'pw-b-123456' })
    const mine = ((await user.from('sheets').insert({ name: 'B own' }).select('id').single()).data as { id: string }).id

    const store = createSupabaseWhatsAppStore(createFakeSupabase({ storage, serviceRole: true }) as never)
    expect(await store.accessibleSheets(b, 10)).toEqual([
      { id: mine, name: 'B own', role: 'owner' },
      { id: sheet, name: 'Tower A', role: 'editor' },
    ])
    expect(await store.sheetRole(b, sheet)).toBe('editor')
    expect(await store.sheetRole(b, other)).toBeNull()
    expect(await store.sheetRole(a, sheet)).toBe('owner')
    expect(await store.sheetRole(b, mine)).toBe('owner')
    expect((await store.accessibleSheets(a, 10)).map((s) => s.name).sort()).toEqual(['Private', 'Tower A'])
  })
})
