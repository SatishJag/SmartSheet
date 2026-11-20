// @vitest-environment node
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase, type StorageLike } from '../../e2e/support/fakeSupabase'
import type { Action, Trigger } from '../../src/automation/types'
import { createApp } from '../app'
import { silentLogger } from '../log'
import { createAutomation, type Automation } from './index'
import { createResendMailer, type MailMessage, type Mailer } from './mailer'
import { hashToken, generateToken } from './tokens'

// The real store code runs against the in-memory fake in SERVICE mode (no row-level security), with a
// fake clock and a fake mailer. The real row-level security of the tables is tested in src/db/automation.test.ts.

type Fake = ReturnType<typeof createFakeSupabase>
interface World {
  user: Fake
  service: Fake
  now: { t: number }
  mails: MailMessage[]
  mailer: Mailer
  automation: Automation
  server: Server
  base: string
  ids: { owner: string; sheet: string; rowA: string; rowB: string; task: string; status: string; hours: string; due: string; start: string }
  auth: Record<string, string>
}

const T0 = Date.UTC(2026, 10, 16, 10, 0, 0) // Monday 2026-11-16 10:00 UTC
const DAY = 86_400_000
const OWNER = { email: 'owner@example.com', password: 'secret-password' }

function memoryStorage(): StorageLike {
  const map = new Map<string, string>()
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

let world: World
const servers: Server[] = []

async function makeWorld(opts: { mail?: 'sim' | 'real'; anonymousOwner?: boolean; env?: Record<string, string>; limits?: Parameters<typeof createAutomation>[2] extends infer O ? (O extends { limits?: infer L } ? L : never) : never } = {}): Promise<World> {
  const storage = memoryStorage()
  const user = createFakeSupabase({ storage })
  const service = createFakeSupabase({ storage, serviceRole: true })
  const signed = opts.anonymousOwner ? await user.auth.signInAnonymously() : await user.auth.signUp(OWNER)
  const owner = signed.data.user!.id
  const one = async <T>(q: PromiseLike<{ data: T | null; error: { message: string } | null }>) => {
    const r = await q
    if (r.error) throw new Error(r.error.message)
    return r.data as T
  }
  const sheet = (await one(user.from('sheets').insert({ name: 'Tower A' }).select('id').single())) as { id: string }
  const cols = (await one(
    user
      .from('columns')
      .insert([
        { sheet_id: sheet.id, title: 'Task', type: 'TEXT_NUMBER', position: 0 },
        { sheet_id: sheet.id, title: 'Status', type: 'PICKLIST', position: 1, options: ['Not started', 'In progress', 'Done', 'Approved', 'Declined'] },
        { sheet_id: sheet.id, title: 'Hours', type: 'TEXT_NUMBER', position: 2 },
        { sheet_id: sheet.id, title: 'Due', type: 'DATE', position: 3 },
        { sheet_id: sheet.id, title: 'Start', type: 'DATE', role: 'start', position: 4 },
      ])
      .select('id, title'),
  )) as { id: string; title: string }[]
  const col = (t: string) => cols.find((c) => c.title === t)!.id
  const rowA = (await one(user.from('rows').insert({ sheet_id: sheet.id, position: 'a0', cells: { [col('Task')]: 'Pour slab', [col('Status')]: 'In progress', [col('Hours')]: 8, [col('Due')]: '2026-11-19' } }).select('id').single())) as { id: string }
  const rowB = (await one(user.from('rows').insert({ sheet_id: sheet.id, position: 'a1', cells: { [col('Task')]: 'Secret task', [col('Hours')]: 99 } }).select('id').single())) as { id: string }

  const now = { t: T0 }
  const mails: MailMessage[] = []
  const mailer: Mailer = opts.mail === 'real' ? { kind: 'resend', send: async (m) => (mails.push(m), { id: 'm1' }) } : { kind: 'simulator', send: async (m) => (mails.push(m), { id: null }) }
  const auth: Record<string, string> = { 'owner-token': owner }
  const automation = createAutomation(
    { SUPABASE_URL: 'http://db.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', PUBLIC_APP_URL: 'https://app.example.com/', ...(opts.env ?? {}) },
    silentLogger,
    {
      serviceClient: service as unknown as SupabaseClient,
      mailer,
      now: () => now.t,
      authenticate: async (token) => (auth[token] ? { userId: auth[token] } : null),
      ...(opts.limits ? { limits: opts.limits } : {}),
    },
  )
  const server = createApp({ staticDir: '/nonexistent', authenticate: null, anthropic: null, automation: automation.handle, log: silentLogger })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { user, service, now, mails, mailer, automation, server, base, auth, ids: { owner, sheet: sheet.id, rowA: rowA.id, rowB: rowB.id, task: col('Task'), status: col('Status'), hours: col('Hours'), due: col('Due'), start: col('Start') } }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

const json = { 'Content-Type': 'application/json' }
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(world.base + path, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers }
}
async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(world.base + path, { headers })
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers }
}
const asOwner = { Authorization: 'Bearer owner-token' }

async function createUpdate(over: Record<string, unknown> = {}) {
  const { ids } = world
  return post(
    '/api/automation/requests',
    { kind: 'update', sheetId: ids.sheet, rowId: ids.rowA, emails: ['sub@example.com'], message: 'Please update the hours', expiresInDays: 7, columnIds: [ids.hours, ids.status], ...over },
    asOwner,
  )
}
const tokenOf = (path: string) => path.split('/').pop()!
const requestPath = (r: { body: Record<string, unknown> }) => ((r.body.requests as { path: string }[])[0]).path
const cellsOf = async (rowId: string) => ((await world.service.from('rows').select('cells, version').eq('id', rowId).single()).data as { cells: Record<string, unknown>; version: number })

describe('update requests', () => {
  beforeEach(async () => {
    world = await makeWorld({ mail: 'real' })
  })

  it('creates a link, e-mails it once, and stores only the hash', async () => {
    const r = await createUpdate()
    expect(r.status).toBe(200)
    const item = (r.body.requests as { id: string; email: string; path: string; url: string; mail: string }[])[0]
    expect(item).toMatchObject({ email: 'sub@example.com', mail: 'sent', url: `https://app.example.com${item.path}` })
    expect(item.path).toMatch(/^\/u\/[A-Za-z0-9_-]{43}$/)
    expect(world.mails).toHaveLength(1)
    expect(world.mails[0]).toMatchObject({ to: 'sub@example.com', replyTo: 'owner@example.com' })
    expect(world.mails[0].text).toContain(item.url)
    const stored = (await world.service.from('update_requests').select('*')).data as Record<string, unknown>[]
    expect(stored).toHaveLength(1)
    expect(stored[0].token_hash).toBe(hashToken(tokenOf(item.path)))
    expect(JSON.stringify(stored)).not.toContain(tokenOf(item.path)) // the token itself is nowhere in the database
    expect(stored[0].expires_at).toBe(new Date(T0 + 7 * DAY).toISOString())
  })

  it('shows ONLY the requested columns and nothing that identifies the row', async () => {
    const path = requestPath(await createUpdate())
    const page = await get(`/api${path}`)
    expect(page.status).toBe(200)
    const text = JSON.stringify(page.body)
    expect(page.body).toMatchObject({ ok: true, kind: 'update', sheetName: 'Tower A', message: 'Please update the hours' })
    expect((page.body.fields as { title: string }[]).map((f) => f.title)).toEqual(['Hours', 'Status'])
    expect((page.body.fields as { options?: string[] }[])[1].options).toContain('Done')
    for (const leak of ['Pour slab', 'Secret task', world.ids.rowA, world.ids.owner, world.ids.sheet, 'Due', 'owner@example.com', '2026-11-19']) expect(text).not.toContain(leak)
    expect(page.headers.get('cache-control')).toBe('no-store')
    expect(page.headers.get('referrer-policy')).toBe('no-referrer')
    expect(page.headers.get('x-robots-tag')).toContain('noindex')
  })

  it('writes validated values to the row, once, and tells the owner', async () => {
    const path = requestPath(await createUpdate())
    const before = await cellsOf(world.ids.rowA)
    const res = await post(`/api${path}`, { values: { [world.ids.hours]: '12', [world.ids.status]: 'Done' } })
    expect(res).toMatchObject({ status: 200, body: { ok: true } })
    const after = await cellsOf(world.ids.rowA)
    expect(after.cells).toMatchObject({ [world.ids.hours]: 12, [world.ids.status]: 'Done', [world.ids.task]: 'Pour slab' }) // other cells kept
    expect(after.version).toBe(before.version + 1)
    const again = await post(`/api${path}`, { values: { [world.ids.hours]: '13' } })
    expect(again.status).toBe(410)
    expect(again.body.error).toMatch(/already been used/)
    expect((await get(`/api${path}`)).status).toBe(410)
    expect((await cellsOf(world.ids.rowA)).cells[world.ids.hours]).toBe(12)
    const notes = (await world.service.from('notifications').select('title, body, channel, kind').eq('channel', 'app')).data as { title: string; body: string; kind: string }[]
    expect(notes).toMatchObject([{ kind: 'update_request', title: expect.stringContaining('sub@example.com') }])
    expect(notes[0].body).toContain('Hours: 12')
  })

  it('refuses columns that were not requested, bad types, formulas and unknown options, leaving the link usable', async () => {
    const path = requestPath(await createUpdate())
    const { ids } = world
    const send = (values: unknown) => post(`/api${path}`, { values })
    expect((await send({ [ids.task]: 'Hacked' })).body).toMatchObject({ ok: false, fieldId: ids.task })
    expect(await send({ [ids.hours]: '=SUM(1,2)' })).toMatchObject({ status: 400, body: { fieldId: ids.hours } })
    expect(await send({ [ids.hours]: ' =1' })).toMatchObject({ status: 400 })
    expect(await send({ [ids.status]: 'Finished' })).toMatchObject({ status: 400, body: { error: expect.stringContaining('Choose one of') } })
    expect(await send({ [ids.hours]: 'x'.repeat(3000) })).toMatchObject({ status: 400 })
    expect(await send({ [ids.hours]: { evil: true } })).toMatchObject({ status: 400 })
    expect(await send({})).toMatchObject({ status: 400 })
    expect(await send('not an object')).toMatchObject({ status: 400 })
    expect((await cellsOf(ids.rowA)).cells[ids.hours]).toBe(8) // nothing was written
    expect(await send({ [ids.hours]: '9' })).toMatchObject({ status: 200 }) // and the link still works
  })

  it('does not let a response overwrite a formula cell', async () => {
    const { ids } = world
    await world.service.from('rows').update({ cells: { [ids.hours]: '=1+1', [ids.status]: 'In progress' } }).eq('id', ids.rowA)
    const path = requestPath(await createUpdate())
    const page = await get(`/api${path}`)
    expect((page.body.fields as { id: string; editable: boolean; value: unknown }[]).find((f) => f.id === ids.hours)).toMatchObject({ editable: false, value: null })
    expect(await post(`/api${path}`, { values: { [ids.hours]: '5' } })).toMatchObject({ status: 400 })
  })

  it('expires: after the date the link answers 410 and the request is marked expired', async () => {
    const path = requestPath(await createUpdate({ expiresInDays: 2 }))
    world.now.t = T0 + 2 * DAY - 1
    expect((await get(`/api${path}`)).status).toBe(200)
    world.now.t = T0 + 2 * DAY + 1
    const res = await get(`/api${path}`)
    expect(res).toMatchObject({ status: 410, body: { state: 'expired' } })
    expect((await post(`/api${path}`, { values: { [world.ids.hours]: '1' } })).status).toBe(410)
    expect(((await world.service.from('update_requests').select('status')).data as { status: string }[])[0].status).toBe('expired')
  })

  it('a revoked request is gone for the recipient', async () => {
    const path = requestPath(await createUpdate())
    await world.service.from('update_requests').update({ status: 'revoked' }).eq('recipient_email', 'sub@example.com')
    expect(await get(`/api${path}`)).toMatchObject({ status: 410, body: { state: 'revoked' } })
  })

  it('a wrong token, a malformed token and another kind of link are all 404', async () => {
    const real = tokenOf(requestPath(await createUpdate()))
    expect((await get(`/api/u/${generateToken()}`)).status).toBe(404)
    expect((await get('/api/u/short')).status).toBe(404)
    expect((await get(`/api/u/${'A'.repeat(44)}`)).status).toBe(404)
    expect((await get('/api/u/%E0%A4%A')).status).toBe(404) // a bad escape is just a bad token
    expect((await get(`/api/a/${real}`)).status).toBe(404) // an update token is not an approval token
    expect((await get(`/api/u/${real}`)).status).toBe(200)
  })

  it('too many wrong guesses block the address for ten minutes, even for a good link; the per-minute limit holds too', async () => {
    const good = requestPath(await createUpdate())
    for (let i = 0; i < 15; i++) expect((await get(`/api/u/${generateToken()}`)).status).toBe(404)
    const blocked = await get(`/api${good}`)
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBeTruthy()
    world.now.t += 10 * 60_000 + 1
    expect((await get(`/api${good}`)).status).toBe(200)
  })

  it('limits requests per minute per address, and a forged X-Forwarded-For does not help without a trusted proxy', async () => {
    const good = requestPath(await createUpdate())
    const statuses: number[] = []
    for (let i = 0; i < 62; i++) statuses.push((await get(`/api${good}`, { 'X-Forwarded-For': `10.0.0.${i}` })).status)
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true)
    expect(statuses.slice(60)).toEqual([429, 429])
    world.now.t += 61_000
    expect((await get(`/api${good}`)).status).toBe(200)
  })

  it('accepts only small JSON bodies and the right methods', async () => {
    const path = `/api${requestPath(await createUpdate())}`
    const text = await fetch(world.base + path, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'values' })
    expect(text.status).toBe(415)
    const big = await fetch(world.base + path, { method: 'POST', headers: json, body: JSON.stringify({ values: { x: 'y'.repeat(20_000) } }) })
    expect(big.status).toBe(413)
    const bad = await fetch(world.base + path, { method: 'POST', headers: json, body: '{nope' })
    expect(bad.status).toBe(400)
    const del = await fetch(world.base + path, { method: 'DELETE' })
    expect(del.status).toBe(405)
    expect(del.headers.get('allow')).toBe('GET, POST')
  })

  it('does not exist for a locked row or a deleted row', async () => {
    const { ids } = world
    const path = requestPath(await createUpdate())
    await world.service.from('row_locks').insert({ row_id: ids.rowA, sheet_id: ids.sheet, owner_id: ids.owner, workspace_id: ids.owner })
    expect(await post(`/api${path}`, { values: { [ids.hours]: '1' } })).toMatchObject({ status: 423 })
    expect((await createUpdate()).status).toBe(423) // and no new one can be created
    await world.service.from('rows').delete().eq('id', ids.rowA)
    expect((await get(`/api${path}`)).status).toBe(404) // the request went with its row
  })
})

describe('creating requests (signed in)', () => {
  beforeEach(async () => {
    world = await makeWorld({ mail: 'real' })
  })

  it('needs a signed-in user and only the sheet owner may use it (a stranger gets the same 404 as a missing sheet)', async () => {
    const { ids } = world
    const body = { kind: 'update', sheetId: ids.sheet, rowId: ids.rowA, emails: ['a@b.co'], expiresInDays: 3, columnIds: [ids.hours] }
    expect((await post('/api/automation/requests', body)).status).toBe(401)
    expect((await post('/api/automation/requests', body, { Authorization: 'Bearer nope' })).status).toBe(401)
    world.auth['stranger-token'] = '99999999-9999-4999-8999-999999999999'
    expect((await post('/api/automation/requests', body, { Authorization: 'Bearer stranger-token' })).status).toBe(404)
    expect((await post('/api/automation/requests', { ...body, sheetId: '00000000-0000-4000-8000-000000000000' }, asOwner)).status).toBe(404)
    expect(((await world.service.from('update_requests').select('id')).data as unknown[]).length).toBe(0)
  })

  it('validates recipients, expiry, columns and message', async () => {
    const { ids } = world
    expect(await createUpdate({ emails: [] })).toMatchObject({ status: 400 })
    expect(await createUpdate({ emails: ['not-an-email'] })).toMatchObject({ status: 400 })
    expect(await createUpdate({ emails: Array.from({ length: 11 }, (_, i) => `u${i}@x.io`) })).toMatchObject({ status: 400 })
    expect(await createUpdate({ expiresInDays: 0 })).toMatchObject({ status: 400 })
    expect(await createUpdate({ expiresInDays: 91 })).toMatchObject({ status: 400 })
    expect(await createUpdate({ columnIds: [] })).toMatchObject({ status: 400 })
    expect(await createUpdate({ columnIds: ['nope'] })).toMatchObject({ status: 400 })
    expect(await createUpdate({ message: 'x'.repeat(2001) })).toMatchObject({ status: 400 })
    expect(await createUpdate({ kind: 'launch' })).toMatchObject({ status: 400 })
    expect(await createUpdate({ columnIds: [ids.hours], rowId: '00000000-0000-4000-8000-000000000000' })).toMatchObject({ status: 404 })
  })

  it('refuses schedule columns while dependencies are on, and summary rows for roll-ups', async () => {
    const { ids } = world
    await world.service.from('sheets').update({ dependencies_enabled: true }).eq('id', ids.sheet)
    expect(await createUpdate({ columnIds: [ids.start] })).toMatchObject({ status: 400, body: { error: expect.stringContaining('set by the schedule') } })
    await world.service.from('sheets').update({ dependencies_enabled: false }).eq('id', ids.sheet)
    expect((await createUpdate({ columnIds: [ids.start] })).status).toBe(200)
    await world.service.from('rows').insert({ sheet_id: ids.sheet, owner_id: ids.owner, workspace_id: ids.owner, parent_id: ids.rowA, position: 'b0', cells: {} })
    expect(await createUpdate({ columnIds: [ids.start] })).toMatchObject({ status: 400, body: { error: expect.stringContaining('summary row') } })
  })

  it('rate limits creation per user', async () => {
    world = await makeWorld({ mail: 'real', limits: { createPerHourPerUser: 2 } })
    expect((await createUpdate()).status).toBe(200)
    expect((await createUpdate()).status).toBe(200)
    expect((await createUpdate()).status).toBe(429)
  })

  it('gives one link per recipient, each with its own token', async () => {
    const r = await createUpdate({ emails: ['a@x.io', 'B@X.io', 'a@x.io'] })
    const items = r.body.requests as { path: string; email: string }[]
    expect(items.map((i) => i.email)).toEqual(['a@x.io', 'b@x.io'])
    expect(new Set(items.map((i) => i.path)).size).toBe(2)
    expect(world.mails).toHaveLength(2)
  })
})

describe('approvals', () => {
  beforeEach(async () => {
    world = await makeWorld({ mail: 'real' })
  })
  const approval = (over: Record<string, unknown> = {}) => ({ statusColumnId: world.ids.status, pendingValue: 'In progress', approvedValue: 'Approved', declinedValue: 'Declined', showColumnIds: [world.ids.hours], ...over })
  const create = (a = approval()) =>
    post('/api/automation/requests', { kind: 'approval', sheetId: world.ids.sheet, rowId: world.ids.rowA, emails: ['boss@example.com'], message: 'OK to proceed?', expiresInDays: 5, approval: a }, asOwner)

  it('shows only the question and the chosen columns; approving writes the status once', async () => {
    const r = await create()
    expect(r.status).toBe(200)
    const path = requestPath(r)
    expect(path).toMatch(/^\/a\//)
    const page = await get(`/api${path}`)
    expect(page.body).toMatchObject({ ok: true, kind: 'approval', approveLabel: 'Approved', declineLabel: 'Declined', shown: [{ title: 'Hours', value: '8' }] })
    expect(JSON.stringify(page.body)).not.toContain('Pour slab')
    const done = await post(`/api${path}`, { decision: 'approved', comment: ' Go ahead ' })
    expect(done.status).toBe(200)
    expect((await cellsOf(world.ids.rowA)).cells[world.ids.status]).toBe('Approved')
    expect((await post(`/api${path}`, { decision: 'declined' })).status).toBe(410)
    expect((await cellsOf(world.ids.rowA)).cells[world.ids.status]).toBe('Approved') // the second answer changed nothing
    const row = ((await world.service.from('approval_requests').select('status, decision_comment')).data as { status: string; decision_comment: string }[])[0]
    expect(row).toEqual({ status: 'approved', decision_comment: 'Go ahead' })
  })

  it('declining writes the declined value; a pending value is written when the request is sent', async () => {
    await world.service.from('rows').update({ cells: { [world.ids.status]: 'Not started' } }).eq('id', world.ids.rowA)
    const path = requestPath(await create())
    expect((await cellsOf(world.ids.rowA)).cells[world.ids.status]).toBe('In progress')
    await post(`/api${path}`, { decision: 'declined', comment: 'Needs a drawing' })
    expect((await cellsOf(world.ids.rowA)).cells[world.ids.status]).toBe('Declined')
    const note = ((await world.service.from('notifications').select('title, body').eq('channel', 'app')).data as { title: string; body: string }[])[0]
    expect(note.title).toContain('declined')
    expect(note.body).toBe('Needs a drawing')
  })

  it('rejects an unknown decision and options the status column does not have', async () => {
    const path = requestPath(await create())
    expect((await post(`/api${path}`, { decision: 'maybe' })).status).toBe(400)
    expect((await post(`/api${path}`, {})).status).toBe(400)
    expect((await create(approval({ approvedValue: 'Yes please' }))).status).toBe(400)
    expect((await create(approval({ declinedValue: 'approved' }))).status).toBe(400) // must differ (ignoring case)
    expect((await create(approval({ statusColumnId: 'nope' }))).status).toBe(400)
    expect((await post(`/api${path}`, { decision: 'approved' })).status).toBe(200)
  })
})

describe('e-mail policy and the scheduler', () => {
  async function queue(w: World, rows: { frequency: 'immediately' | 'daily' | 'weekly'; deliverAfter: number; to?: string; title?: string }[]) {
    await w.service.from('notifications').insert(
      rows.map((r, i) => ({
        owner_id: w.ids.owner,
        sheet_id: w.ids.sheet,
        channel: 'email',
        recipient_email: r.to ?? 'a@x.io',
        title: r.title ?? `Update ${i}`,
        body: `Row ${i} changed`,
        frequency: r.frequency,
        deliver_after: new Date(r.deliverAfter).toISOString(),
      })),
    )
  }
  const statuses = async (w: World) => ((await w.service.from('notifications').select('delivery_status').eq('channel', 'email').order('created_at')).data as { delivery_status: string }[]).map((r) => r.delivery_status)

  it('delivers due digests as ONE message per recipient, leaves later ones, and never repeats', async () => {
    world = await makeWorld({ mail: 'real' })
    await queue(world, [
      { frequency: 'daily', deliverAfter: T0 - 1000 },
      { frequency: 'daily', deliverAfter: T0 - 500 },
      { frequency: 'daily', deliverAfter: T0 - 100 },
      { frequency: 'daily', deliverAfter: T0 + DAY },
      { frequency: 'immediately', deliverAfter: T0 - 10, to: 'b@x.io' },
    ])
    expect(await world.automation.scheduler!.tick()).toEqual({ runs: 0, emails: 2 })
    const sent = [...world.mails].sort((a, b) => a.to.localeCompare(b.to))
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      ['a@x.io', '3 updates'],
      ['b@x.io', 'Update 4'],
    ])
    expect(sent[0].text).toContain('Row 2 changed')
    expect((await statuses(world)).sort()).toEqual(['pending', 'sent', 'sent', 'sent', 'sent'])
    await world.automation.scheduler!.tick()
    expect(world.mails).toHaveLength(2)
    world.now.t = T0 + DAY + 1
    await world.automation.scheduler!.tick()
    expect(world.mails).toHaveLength(3)
  })

  it('includes a link to the sheet and row in the message', async () => {
    world = await makeWorld({ mail: 'real' })
    await world.service.from('notifications').insert({ owner_id: world.ids.owner, sheet_id: world.ids.sheet, row_id: world.ids.rowA, channel: 'email', recipient_email: 'a@x.io', title: 'T', body: 'B', frequency: 'immediately', deliver_after: new Date(T0 - 1).toISOString() })
    await world.automation.scheduler!.tick()
    expect(world.mails[0].text).toBe(`B\n\nhttps://app.example.com/?sheet=${world.ids.sheet}&row=${world.ids.rowA}`)
  })

  it('simulator mode sends nothing and shows the message in the owner notification centre instead', async () => {
    world = await makeWorld({ mail: 'sim' })
    await queue(world, [{ frequency: 'immediately', deliverAfter: T0 - 1, title: 'Hello' }])
    await world.automation.scheduler!.tick()
    expect(await statuses(world)).toEqual(['simulated'])
    const note = ((await world.service.from('notifications').select('title, body').eq('channel', 'app')).data as { title: string; body: string }[])[0]
    expect(note.title).toContain('a@x.io')
    expect(note.body).toContain('simulated')
    expect(note.body).toContain('Row 0 changed')
  })

  it('an anonymous owner gets no real e-mail by default (and the message is kept for them), but may when the operator allows it', async () => {
    world = await makeWorld({ mail: 'real', anonymousOwner: true })
    await queue(world, [{ frequency: 'immediately', deliverAfter: T0 - 1 }])
    await world.automation.scheduler!.tick()
    expect(world.mails).toHaveLength(0)
    expect(await statuses(world)).toEqual(['skipped'])
    expect(((await world.service.from('notifications').select('body').eq('channel', 'app')).data as { body: string }[])[0].body).toContain('signed-in accounts')

    world = await makeWorld({ mail: 'real', anonymousOwner: true, env: { AUTOMATION_EMAIL_ALLOW_ANONYMOUS: 'true' } })
    await queue(world, [{ frequency: 'immediately', deliverAfter: T0 - 1 }])
    await world.automation.scheduler!.tick()
    expect(world.mails).toHaveLength(1)
  })

  it('applies a daily cap per owner', async () => {
    world = await makeWorld({ mail: 'real', env: { AUTOMATION_EMAIL_PER_DAY: '2' } })
    await queue(world, [0, 1, 2, 3].map((i) => ({ frequency: 'immediately' as const, deliverAfter: T0 - 10, to: `u${i}@x.io` })))
    await world.automation.scheduler!.tick()
    expect(world.mails).toHaveLength(2)
    expect((await statuses(world)).sort()).toEqual(['sent', 'sent', 'skipped', 'skipped'])
  })

  it('records a failure and keeps the others going', async () => {
    world = await makeWorld({ mail: 'real' })
    let n = 0
    world.mailer.send = async (m) => {
      if (n++ === 0) throw new Error('provider down')
      world.mails.push(m)
      return { id: null }
    }
    await queue(world, [{ frequency: 'immediately', deliverAfter: T0 - 1, to: 'a@x.io' }, { frequency: 'immediately', deliverAfter: T0 - 1, to: 'b@x.io' }])
    await world.automation.scheduler!.tick()
    expect((await statuses(world)).sort()).toEqual(['failed', 'sent'])
  })

  async function addRule(trigger: Trigger, action: Action, over: Record<string, unknown> = {}) {
    const r = await world.service.from('automation_rules').insert({ sheet_id: world.ids.sheet, owner_id: world.ids.owner, workspace_id: world.ids.owner, name: 'Rule', trigger, action, created_at: new Date(T0 - 7 * DAY).toISOString(), ...over }).select('id').single()
    return (r.data as { id: string }).id
  }
  const runs = async () => (await world.service.from('automation_runs').select('rule_name, outcome, source, dedup_key, detail')).data as { outcome: string; source: string; dedup_key: string | null; detail: Record<string, unknown> }[]
  const appNotes = async () => (await world.service.from('notifications').select('title, body').eq('channel', 'app')).data as { title: string; body: string }[]

  it('runs a date rule on the day, once, even if the server ticks all day and from two instances', async () => {
    world = await makeWorld({ mail: 'real' })
    const { ids } = world
    await addRule({ type: 'date', columnId: ids.due, when: 'before', days: 3 }, { type: 'notify', recipients: [{ kind: 'owner' }], frequency: 'immediately', include: 'columns', columnIds: [ids.task], linkToRow: true }, { name: 'Due soon' })
    // 2026-11-19 - 3 days = today
    const second = createAutomation({ SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service', PUBLIC_APP_URL: 'https://app.example.com' }, silentLogger, { serviceClient: world.service as unknown as SupabaseClient, mailer: world.mailer, now: () => world.now.t })
    await Promise.all([world.automation.scheduler!.tick(), second.scheduler!.tick()])
    world.now.t += 3_600_000
    await world.automation.scheduler!.tick()
    const notes = await appNotes()
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ title: 'Due soon: Pour slab', body: 'Task: Pour slab' })
    const log = await runs()
    expect(log.filter((r) => r.outcome === 'done')).toHaveLength(1)
    expect(log[0].source).toBe('server')
    expect(log[0].dedup_key).toContain(`:${ids.rowA}:2026-11-19:2026-11-16`)
    // tomorrow the date is "2 days before": nothing
    world.now.t = T0 + DAY
    await world.automation.scheduler!.tick()
    expect(await appNotes()).toHaveLength(1)
  })

  it('runs a recurring rule once per occurrence and sends ONE digest for all matching rows', async () => {
    world = await makeWorld({ mail: 'real' })
    const { ids } = world
    await world.service.from('rows').update({ cells: { [ids.task]: 'Pour slab', [ids.status]: 'In progress' } }).eq('id', ids.rowA)
    await world.service.from('rows').update({ cells: { [ids.task]: 'Secret task', [ids.status]: 'Done' } }).eq('id', ids.rowB)
    await addRule(
      { type: 'schedule', frequency: 'daily', time: '09:00' },
      { type: 'notify', recipients: [{ kind: 'owner' }, { kind: 'email', email: 'pm@example.com' }], frequency: 'immediately', include: 'none', linkToRow: true },
      { name: 'Daily open items', conditions: { op: 'and', items: [{ columnId: ids.status, op: 'is_not', value: 'Done' }] } },
    )
    await world.automation.scheduler!.tick() // 10:00: today's 09:00 occurrence is due
    await world.automation.scheduler!.tick() // and does not repeat
    expect(await appNotes()).toHaveLength(1)
    expect(world.mails.map((m) => m.to)).toEqual(['pm@example.com'])
    expect(world.mails[0].subject).toBe('Daily open items: Pour slab')
    expect(JSON.stringify(world.mails)).not.toContain('Secret task') // not matching the conditions
    world.now.t = T0 + DAY
    await world.automation.scheduler!.tick()
    expect(await appNotes()).toHaveLength(2)
    expect(world.mails).toHaveLength(2)
  })

  it('records a date, locks, and copies rows from rules that run on the server', async () => {
    world = await makeWorld({ mail: 'real' })
    const { ids } = world
    await addRule({ type: 'date', columnId: ids.due, when: 'before', days: 3 }, { type: 'lock', locked: true }, { name: 'Lock' })
    await world.automation.scheduler!.tick()
    expect(((await world.service.from('row_locks').select('row_id')).data as { row_id: string }[]).map((r) => r.row_id)).toEqual([ids.rowA])
    // a rule that writes to a locked row is skipped, not applied
    await addRule({ type: 'date', columnId: ids.due, when: 'before', days: 3 }, { type: 'record_date', columnId: ids.start }, { name: 'Stamp' })
    await world.automation.scheduler!.tick()
    expect((await cellsOf(ids.rowA)).cells[ids.start]).toBeUndefined()
    expect((await runs()).some((r) => r.outcome === 'skipped' && r.detail.reason === 'locked')).toBe(true)
  })

  it('stamps today in a date column for an unlocked row', async () => {
    world = await makeWorld({ mail: 'real' })
    const { ids } = world
    await addRule({ type: 'date', columnId: ids.due, when: 'before', days: 3 }, { type: 'record_date', columnId: ids.start }, { name: 'Stamp' })
    await world.automation.scheduler!.tick()
    expect((await cellsOf(ids.rowA)).cells[ids.start]).toBe('2026-11-16')
  })

  it('a rule can start update requests: the server creates the links and e-mails them', async () => {
    world = await makeWorld({ mail: 'real' })
    const { ids } = world
    await world.service.from('rows').update({ cells: { [ids.task]: 'Pour slab', [ids.hours]: 8, [ids.due]: '2026-11-19', [ids.status]: 'sub@example.com' } }).eq('id', ids.rowA)
    await addRule({ type: 'date', columnId: ids.due, when: 'before', days: 3 }, { type: 'update_request', recipients: [{ kind: 'email', email: 'sub@example.com' }], columnIds: [ids.hours], message: 'Hours for {{Task}}?', expiresInDays: 4 })
    await world.automation.scheduler!.tick()
    expect(world.mails).toHaveLength(1)
    expect(world.mails[0].text).toContain('Hours for Pour slab?')
    expect(world.mails[0].text).toMatch(/https:\/\/app\.example\.com\/u\/[A-Za-z0-9_-]{43}/)
    expect(((await world.service.from('update_requests').select('rule_id, status')).data as { status: string }[])[0].status).toBe('pending')
  })
})

describe('when the server has no service-role key', () => {
  it('the features that need it answer 503 with the reason; the status endpoint still needs a sign-in', async () => {
    const storage = memoryStorage()
    const automation = createAutomation({ SUPABASE_URL: 'http://db.test', SUPABASE_ANON_KEY: 'anon' }, silentLogger, { authenticate: async (t) => (t === 'ok' ? { userId: 'u1' } : null) })
    expect(automation.scheduler).toBeNull()
    const server = createApp({ staticDir: '/x', authenticate: null, anthropic: null, automation: automation.handle, log: silentLogger })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    servers.push(server)
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    void storage
    const link = await fetch(`${base}/api/u/${generateToken()}`)
    expect(link.status).toBe(503)
    expect(((await link.json()) as { error: string }).error).toContain('SUPABASE_SERVICE_ROLE_KEY')
    expect((await fetch(`${base}/api/automation/status`)).status).toBe(401)
    const status = await fetch(`${base}/api/automation/status`, { headers: { Authorization: 'Bearer ok' } })
    expect(await status.json()).toEqual({ ok: true, enabled: false, mail: 'simulator' })
    const create = await fetch(`${base}/api/automation/requests`, { method: 'POST', headers: { ...json, Authorization: 'Bearer ok' }, body: '{}' })
    expect(create.status).toBe(503)
  })

  it('does not touch the planner routes and falls through for other paths', async () => {
    const automation = createAutomation({}, silentLogger)
    const server = createApp({ staticDir: '/x', authenticate: null, anthropic: null, automation: automation.handle, log: silentLogger })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    servers.push(server)
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true })
    expect((await fetch(`${base}/api/planner/options`)).status).toBe(503)
    expect((await fetch(`${base}/api/nothing`)).status).toBe(404)
  })
})

describe('status', () => {
  it('reports what the server can do to a signed-in user', async () => {
    world = await makeWorld({ mail: 'real' })
    expect((await get('/api/automation/status', asOwner)).body).toEqual({ ok: true, enabled: true, mail: 'resend' })
    expect((await post('/api/automation/status', {}, asOwner)).status).toBe(405)
  })
})

describe('the Resend adapter', () => {
  it('posts the message with the key in the header only, and returns the id', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: 'abc' }), { status: 200 }))
    const mailer = createResendMailer({ apiKey: 're_secret', from: 'App <app@example.com>', fetch: f as unknown as typeof fetch })
    expect(await mailer.send({ to: 'a@b.co', subject: 'Hi', text: 'Body', replyTo: 'o@x.io' })).toEqual({ id: 'abc' })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_secret')
    expect(JSON.parse(init.body as string)).toEqual({ from: 'App <app@example.com>', to: ['a@b.co'], subject: 'Hi', text: 'Body', reply_to: 'o@x.io' })
    expect(init.body).not.toContain('re_secret')
  })

  it('turns an error response into a short message without echoing the request or the key', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ message: 'Domain not verified', name: 'validation_error' }), { status: 403 }))
    const mailer = createResendMailer({ apiKey: 're_secret', from: 'a@b.co', fetch: f as unknown as typeof fetch })
    const err = await mailer.send({ to: 'x@y.co', subject: 's', text: 't' }).catch((e: Error) => e)
    expect((err as Error).message).toBe('Mail provider answered 403: Domain not verified')
    expect((err as Error).message).not.toContain('re_secret')
  })
})

describe('configuration', () => {
  it('is off without the service-role key and picks the mail provider from the environment', async () => {
    const { readAutomationConfig } = await import('./config')
    expect(readAutomationConfig({ SUPABASE_URL: 'u' })).toMatchObject({ config: null, reason: expect.stringContaining('SUPABASE_SERVICE_ROLE_KEY') })
    expect(readAutomationConfig({ SERVICE: 'x', SUPABASE_SERVICE_ROLE_KEY: 'k' })).toMatchObject({ config: null, reason: expect.stringContaining('SUPABASE_URL') })
    const sim = readAutomationConfig({ VITE_SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k' })
    expect(sim.config).toMatchObject({ mail: { kind: 'simulator' }, tickMs: 60_000, emailPerOwnerPerDay: 100, allowAnonymousEmail: false })
    const real = readAutomationConfig({ SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k', RESEND_API_KEY: 're', MAIL_FROM: 'a@b.co', PUBLIC_APP_URL: 'https://x.io///', AUTOMATION_TICK_SECONDS: '5' })
    expect(real.config).toMatchObject({ mail: { kind: 'resend', apiKey: 're', from: 'a@b.co' }, publicUrl: 'https://x.io', tickMs: 5000 })
    // a key without a sender is not enough to send real mail
    expect(readAutomationConfig({ SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k', RESEND_API_KEY: 're' }).config).toMatchObject({ mail: { kind: 'simulator' } })
  })
})
