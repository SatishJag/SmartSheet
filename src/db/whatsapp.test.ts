// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseLikeDb, roles } from './supabaseTestDb'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// Verified against PGlite (Postgres in WASM), not a live Supabase project (see supabaseTestDb.ts).

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const SHEET_A = 'aaaaaaaa-0000-0000-0000-0000000000a1'
const SHEET_B = 'bbbbbbbb-0000-0000-0000-0000000000b1'

let db: PGlite
let as: ReturnType<typeof roles>

beforeAll(async () => {
  db = await createSupabaseLikeDb()
  as = roles(db)
}, 60_000)
afterAll(async () => {
  await db.close()
}, 60_000)

beforeEach(async () => {
  await as.asSuperuser()
  for (const t of ['whatsapp_links', 'whatsapp_contacts', 'whatsapp_codes', 'whatsapp_sessions', 'whatsapp_messages', 'whatsapp_optouts', 'notifications'])
    await db.exec(`delete from ${t}`)
  await db.exec('delete from sheets')
  await as.asUser(A)
  await db.query(`insert into sheets (id, name) values ($1, 'Tower A')`, [SHEET_A])
  await as.asUser(B)
  await db.query(`insert into sheets (id, name) values ($1, 'Villa B')`, [SHEET_B])
})

const fails = async (p: Promise<unknown>) => {
  await expect(p).rejects.toThrow()
}

describe('whatsapp_links', () => {
  it('a user reads and removes only their own link, and cannot create one (the server links)', async () => {
    await as.asSuperuser()
    await db.query(`insert into whatsapp_links (user_id, phone) values ($1, '971501111111'), ($2, '971502222222')`, [A, B])
    await as.asUser(A)
    const mine = await db.query<{ phone: string }>('select phone from whatsapp_links')
    expect(mine.rows.map((r) => r.phone)).toEqual(['971501111111'])
    await fails(db.query(`insert into whatsapp_links (user_id, phone) values ($1, '971503333333')`, [A]))
    await fails(db.query(`update whatsapp_links set phone = '971503333333'`))
    await db.query('delete from whatsapp_links')
    await as.asSuperuser()
    const left = await db.query<{ user_id: string }>('select user_id from whatsapp_links')
    expect(left.rows.map((r) => r.user_id)).toEqual([B])
  })

  it('refuses a phone that is not digits with a country code, and one phone for two users', async () => {
    await as.asSuperuser()
    await fails(db.query(`insert into whatsapp_links (user_id, phone) values ($1, '+971 50 111')`, [A]))
    await db.query(`insert into whatsapp_links (user_id, phone) values ($1, '971501111111')`, [A])
    await fails(db.query(`insert into whatsapp_links (user_id, phone) values ($1, '971501111111')`, [B]))
  })
})

describe('whatsapp_contacts', () => {
  it('the owner manages their contacts; status is the server’s; another user sees nothing', async () => {
    await as.asUser(A)
    await db.query(`insert into whatsapp_contacts (name, email, phone) values ('Ravi (MEP)', 'ravi@sub.example', '971504444444')`)
    await fails(db.query(`insert into whatsapp_contacts (name, email, phone, status) values ('X', 'x@sub.example', '971505555555', 'active')`))
    await fails(db.query(`update whatsapp_contacts set status = 'active'`))
    await fails(db.query(`insert into whatsapp_contacts (name, email, phone) values ('Upper', 'Upper@sub.example', '971505555555')`))
    await as.asUser(B)
    expect((await db.query('select * from whatsapp_contacts')).rows).toHaveLength(0)
    await fails(db.query(`insert into whatsapp_contacts (owner_id, workspace_id, name, email, phone) values ($1, $1, 'Spoof', 's@x.example', '971506666666')`, [A]))
  })

  it('changing the phone of a joined contact makes them join again', async () => {
    await as.asUser(A)
    await db.query(`insert into whatsapp_contacts (name, email, phone) values ('Ravi', 'ravi@sub.example', '971504444444')`)
    await as.asSuperuser()
    await db.exec(`update whatsapp_contacts set status = 'active', joined_at = now()`)
    await as.asUser(A)
    await db.query(`update whatsapp_contacts set name = 'Ravi K'`)
    expect((await db.query<{ status: string }>('select status from whatsapp_contacts')).rows[0].status).toBe('active')
    await db.query(`update whatsapp_contacts set phone = '971507777777'`)
    const r = (await db.query<{ status: string; joined_at: string | null }>('select status, joined_at from whatsapp_contacts')).rows[0]
    expect(r).toEqual({ status: 'invited', joined_at: null })
  })
})

describe('whatsapp_sheet_settings', () => {
  it('only the sheet owner can configure a sheet', async () => {
    await as.asUser(A)
    await db.query(`insert into whatsapp_sheet_settings (sheet_id, summary_hour) values ($1, 9)`, [SHEET_A])
    await fails(db.query(`insert into whatsapp_sheet_settings (sheet_id) values ($1)`, [SHEET_B]))
    await fails(db.query(`update whatsapp_sheet_settings set dnd_start = '25:00'`))
    await as.asUser(B)
    expect((await db.query('select * from whatsapp_sheet_settings')).rows).toHaveLength(0)
  })
})

describe('server-only tables', () => {
  it('codes, sessions and opt-outs are invisible to users; the message log is read-only and own', async () => {
    await as.asSuperuser()
    await db.query(`insert into whatsapp_sessions (phone) values ('971501111111')`)
    await db.query(`insert into whatsapp_optouts (phone) values ('971501111111')`)
    await db.query(`insert into whatsapp_codes (code_hash, kind, user_id, expires_at) values ($1, 'link', $2, now())`, ['b'.repeat(64), A])
    await db.query(
      `insert into whatsapp_messages (owner_id, phone, direction, body, status, provider_id) values ($1, '971501111111', 'out', 'hi A', 'sent', 'wamid.1'), ($2, '971502222222', 'out', 'hi B', 'sent', null)`,
      [A, B],
    )
    await as.asUser(A)
    for (const t of ['whatsapp_sessions', 'whatsapp_optouts', 'whatsapp_codes']) await fails(db.query(`select * from ${t}`))
    const log = await db.query<{ body: string }>('select body from whatsapp_messages')
    expect(log.rows.map((r) => r.body)).toEqual(['hi A'])
    await fails(db.query('select provider_id from whatsapp_messages'))
    await fails(db.query(`insert into whatsapp_messages (owner_id, phone, direction, body, status) values ($1, '1', 'out', 'x', 'pending')`, [A]))
    await fails(db.query(`update whatsapp_messages set status = 'sent'`))
    await as.asAnon()
    await fails(db.query('select * from whatsapp_messages'))
  })

  it('dedup keys and inbound message ids are unique', async () => {
    await as.asSuperuser()
    await db.query(`insert into whatsapp_messages (phone, direction, body, status, dedup_key) values ('971501111111', 'out', 'a', 'pending', 'delay:r1')`)
    await fails(db.query(`insert into whatsapp_messages (phone, direction, body, status, dedup_key) values ('971501111111', 'out', 'a', 'pending', 'delay:r1')`))
    await db.query(`insert into whatsapp_messages (phone, direction, body, status, provider_id) values ('971501111111', 'in', 'hi', 'received', 'wamid.X')`)
    await fails(db.query(`insert into whatsapp_messages (phone, direction, body, status, provider_id) values ('971501111111', 'in', 'hi', 'received', 'wamid.X')`))
  })
})

describe('notifications on WhatsApp', () => {
  it('accepts a whatsapp notification with a recipient, refuses one without', async () => {
    await as.asUser(A)
    await db.query(`insert into notifications (sheet_id, channel, recipient_email, title) values ($1, 'whatsapp', 'ravi@sub.example', 'Slab delayed')`, [SHEET_A])
    await fails(db.query(`insert into notifications (sheet_id, channel, title) values ($1, 'whatsapp', 'No one')`, [SHEET_A]))
    await fails(db.query(`insert into notifications (sheet_id, channel, recipient_email, title) values ($1, 'sms', 'a@b.example', 'x')`, [SHEET_A]))
    await db.query(`insert into notifications (sheet_id, channel, title) values ($1, 'app', 'In app')`, [SHEET_A])
    await fails(db.query(`insert into notifications (sheet_id, channel, title) values ($1, 'email', 'No address')`, [SHEET_A]))
  })
})
