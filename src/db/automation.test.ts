// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseLikeDb, roles } from './supabaseTestDb'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// Verified against PGlite (Postgres in WASM), not a live Supabase project (see supabaseTestDb.ts).

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const SHEET = 'aaaaaaaa-0000-0000-0000-0000000000a1'
const SHEET2 = 'aaaaaaaa-0000-0000-0000-0000000000a2'
const SHEET_B = 'bbbbbbbb-0000-0000-0000-0000000000b1'
const R1 = 'aaaaaaaa-0000-0000-0000-0000000000c1'
const R2 = 'aaaaaaaa-0000-0000-0000-0000000000c2'
const COL_TASK = 'aaaaaaaa-0000-0000-0000-0000000000d1'
const COL_DATE = 'aaaaaaaa-0000-0000-0000-0000000000d2'
const COL_PRED = 'aaaaaaaa-0000-0000-0000-0000000000d3'
const T_TASK = 'aaaaaaaa-0000-0000-0000-0000000000e1'
const T_DATE = 'aaaaaaaa-0000-0000-0000-0000000000e2'
const T_OTHER = 'aaaaaaaa-0000-0000-0000-0000000000e3'
const HASH = 'a'.repeat(64)

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
  await db.exec('delete from sheets') // cascades to everything below
  await db.exec('delete from automation_runs')
  await db.exec('delete from notifications')
  await as.asUser(A)
  await db.query(`insert into sheets (id, name) values ($1, 'Plan A'), ($2, 'Archive')`, [SHEET, SHEET2])
  await db.query(`insert into rows (id, sheet_id, position, cells) values ($1, $3, 'a0', $4::jsonb), ($2, $3, 'a1', '{}')`, [
    R1,
    R2,
    SHEET,
    JSON.stringify({ [COL_TASK]: 'Pour slab', [COL_DATE]: '2026-11-20', [COL_PRED]: '2' }),
  ])
  await db.query(
    `insert into columns (id, sheet_id, title, type, position) values
       ($1, $4, 'Task', 'TEXT_NUMBER', 0), ($2, $4, 'Due', 'DATE', 1), ($3, $4, 'Predecessors', 'PREDECESSOR', 2),
       ($5, $6, 'task', 'TEXT_NUMBER', 0), ($7, $6, 'DUE', 'DATE', 1), ($8, $6, 'Other', 'TEXT_NUMBER', 2)`,
    [COL_TASK, COL_DATE, COL_PRED, SHEET, T_TASK, SHEET2, T_DATE, T_OTHER],
  )
  await as.asUser(B)
  await db.query(`insert into sheets (id, name) values ($1, 'Plan B')`, [SHEET_B])
  await as.asUser(A)
})

const count = async (table: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n
const trig = JSON.stringify({ type: 'cell_becomes', columnId: COL_TASK, value: 'Done' })
const act = JSON.stringify({ type: 'notify', recipients: [{ kind: 'owner' }], frequency: 'immediately', include: 'all', linkToRow: true })
async function addRule(sheet = SHEET, name = 'Rule'): Promise<string> {
  const r = await db.query<{ id: string }>(`insert into automation_rules (sheet_id, name, trigger, action) values ($1, $2, $3::jsonb, $4::jsonb) returning id`, [sheet, name, trig, act])
  return r.rows[0].id
}

describe('automation_rules', () => {
  it('stores a rule for the owner with defaults, and rejects bad shapes', async () => {
    const id = await addRule()
    const r = await db.query<{ owner_id: string; enabled: boolean; conditions: unknown }>(`select owner_id, enabled, conditions from automation_rules where id = $1`, [id])
    expect(r.rows[0]).toEqual({ owner_id: A, enabled: true, conditions: null })
    const bad = (trigger: string, action = act, name = 'x') =>
      db.query(`insert into automation_rules (sheet_id, name, trigger, action) values ($1, $2, $3::jsonb, $4::jsonb)`, [SHEET, name, trigger, action])
    await expect(bad('{"type":"nonsense"}')).rejects.toThrow()
    await expect(bad('[]')).rejects.toThrow()
    await expect(bad(trig, '{"type":"launch_rocket"}')).rejects.toThrow()
    await expect(bad(trig, act, '   ')).rejects.toThrow()
    await expect(bad(trig, act, 'x'.repeat(101))).rejects.toThrow()
    await expect(db.query(`insert into automation_rules (sheet_id, name, trigger, action, conditions) values ($1, 'c', $2::jsonb, $3::jsonb, '[]')`, [SHEET, trig, act])).rejects.toThrow()
  })

  it("a user sees and changes only their own rules, and cannot attach one to another user's sheet", async () => {
    const id = await addRule()
    await as.asUser(B)
    expect(await count('automation_rules')).toBe(0)
    await expect(addRule(SHEET)).rejects.toThrow() // A's sheet
    const own = await addRule(SHEET_B, 'B rule')
    await db.query(`update automation_rules set enabled = false where id = $1`, [id])
    await db.query(`delete from automation_rules where id = $1`, [id])
    await as.asUser(A)
    expect(await count('automation_rules')).toBe(1) // A's rule untouched
    await as.asUser(B)
    expect(await count('automation_rules')).toBe(1)
    expect((await db.query<{ id: string }>(`select id from automation_rules`)).rows[0].id).toBe(own)
  })

  it('rules disappear with their sheet', async () => {
    await addRule()
    await db.query(`delete from sheets where id = $1`, [SHEET])
    expect(await count('automation_rules')).toBe(0)
  })
})

describe('automation_runs (append-only)', () => {
  const log = (key: string | null = null, outcome = 'done') =>
    db.query(`insert into automation_runs (rule_id, rule_name, sheet_id, row_id, source, outcome, dedup_key) values ($1, 'R', $2, $3, 'browser', $4, $5)`, [
      A,
      SHEET,
      R1,
      outcome,
      key,
    ])

  it('can be appended and read, never updated or deleted by the user', async () => {
    await log()
    expect(await count('automation_runs')).toBe(1)
    await expect(db.query(`update automation_runs set outcome = 'error'`)).rejects.toThrow(/permission denied/)
    await expect(db.query(`delete from automation_runs`)).rejects.toThrow(/permission denied/)
    await expect(db.query(`truncate automation_runs`)).rejects.toThrow(/permission denied/)
  })

  it('records a time based run once per dedup key', async () => {
    await log('rule:schedule:1')
    await expect(log('rule:schedule:1')).rejects.toThrow(/duplicate key/)
    await log('rule:schedule:2')
    await log(null)
    await log(null) // event runs have no key and repeat freely
    expect(await count('automation_runs')).toBe(4)
  })

  it('refuses unknown outcomes and sources, and another user as owner', async () => {
    await expect(log(null, 'weird')).rejects.toThrow()
    await expect(db.query(`insert into automation_runs (rule_name, sheet_id, source, outcome) values ('R', $1, 'cron', 'done')`, [SHEET])).rejects.toThrow()
    await as.asUser(B)
    await expect(log()).rejects.toThrow() // B writing to A's sheet
    expect(await count('automation_runs')).toBe(0)
  })

  it("is private to its owner and survives the rule's deletion", async () => {
    const id = await addRule()
    await db.query(`insert into automation_runs (rule_id, rule_name, sheet_id, source, outcome) values ($1, 'R', $2, 'browser', 'done')`, [id, SHEET])
    await db.query(`delete from automation_rules where id = $1`, [id])
    expect(await count('automation_runs')).toBe(1)
    await as.asUser(B)
    expect(await count('automation_runs')).toBe(0)
  })
})

describe('notifications', () => {
  const app = (title = 'Hello') =>
    db.query(`insert into notifications (sheet_id, row_id, channel, title, body, delivery_status) values ($1, $2, 'app', $3, 'body', 'sent') returning id`, [SHEET, R1, title])

  it('the owner creates app and e-mail rows; only read_at can be changed; they can delete', async () => {
    const { rows } = await app()
    const id = (rows[0] as { id: string }).id
    await db.query(`insert into notifications (sheet_id, channel, recipient_email, title) values ($1, 'email', 'x@y.co', 'Digest')`, [SHEET])
    expect(await count('notifications')).toBe(2)
    await db.query(`update notifications set read_at = now() where id = $1`, [id])
    expect((await db.query<{ read_at: string | null }>(`select read_at from notifications where id = $1`, [id])).rows[0].read_at).not.toBeNull()
    await expect(db.query(`update notifications set title = 'changed' where id = $1`, [id])).rejects.toThrow(/permission denied/)
    await expect(db.query(`update notifications set delivery_status = 'sent'`)).rejects.toThrow(/permission denied/)
    await db.query(`delete from notifications where id = $1`, [id])
    expect(await count('notifications')).toBe(1)
  })

  it('an e-mail row needs an address and an app row must not have one', async () => {
    await expect(db.query(`insert into notifications (channel, title) values ('email', 't')`)).rejects.toThrow()
    await expect(db.query(`insert into notifications (channel, recipient_email, title) values ('app', 'a@b.co', 't')`)).rejects.toThrow()
    await expect(db.query(`insert into notifications (channel, title, frequency) values ('app', 't', 'hourly')`)).rejects.toThrow()
  })

  it("is private: another user sees none, and cannot notify against someone else's sheet or as someone else", async () => {
    await app()
    await as.asUser(B)
    expect(await count('notifications')).toBe(0)
    await expect(app()).rejects.toThrow() // sheet A is not B's
    await expect(db.query(`insert into notifications (owner_id, channel, title) values ($1, 'app', 'spam')`, [A])).rejects.toThrow()
    await db.query(`update notifications set read_at = now()`) // matches no row of B
    await as.asUser(A)
    expect((await db.query<{ read_at: string | null }>(`select read_at from notifications`)).rows[0].read_at).toBeNull()
  })

  it('goes with the sheet; a notification without a sheet is allowed', async () => {
    await app()
    await db.query(`insert into notifications (channel, title) values ('app', 'System')`)
    await db.query(`delete from sheets where id = $1`, [SHEET])
    expect(await count('notifications')).toBe(1)
  })
})

describe('update_requests and approval_requests', () => {
  async function seedRequests() {
    await as.asSuperuser() // the server (service role) creates them
    await db.query(
      `insert into update_requests (sheet_id, row_id, owner_id, workspace_id, token_hash, recipient_email, column_ids, expires_at)
       values ($1, $2, $3, $3, $4, 'p@q.co', $5::jsonb, now() + interval '7 days')`,
      [SHEET, R1, A, HASH, JSON.stringify([COL_TASK])],
    )
    await db.query(
      `insert into approval_requests (sheet_id, row_id, owner_id, workspace_id, token_hash, approver_email, status_column_id, approved_value, declined_value, expires_at)
       values ($1, $2, $3, $3, $4, 'p@q.co', $5, 'Approved', 'Declined', now() + interval '7 days')`,
      [SHEET, R1, A, 'b'.repeat(64), COL_TASK],
    )
    await as.asUser(A)
  }

  it('the owner can list them without the token hash, and cannot read the hash', async () => {
    await seedRequests()
    const ok = await db.query<{ status: string }>(`select id, status, recipient_email, column_ids, expires_at from update_requests`)
    expect(ok.rows[0].status).toBe('pending')
    await expect(db.query(`select token_hash from update_requests`)).rejects.toThrow(/permission denied/)
    await expect(db.query(`select * from update_requests`)).rejects.toThrow(/permission denied/)
    await expect(db.query(`select token_hash from approval_requests`)).rejects.toThrow(/permission denied/)
    await expect(db.query(`select id, status, approver_email from approval_requests`)).resolves.toBeTruthy()
  })

  it('a user cannot create requests or fake a response, but can revoke a pending one', async () => {
    await seedRequests()
    await expect(
      db.query(`insert into update_requests (sheet_id, row_id, token_hash, recipient_email, column_ids, expires_at) values ($1, $2, $3, 'a@b.co', '["x"]', now())`, [SHEET, R1, 'c'.repeat(64)]),
    ).rejects.toThrow(/permission denied/)
    await expect(db.query(`update update_requests set status = 'responded'`)).rejects.toThrow()
    await expect(db.query(`update update_requests set recipient_email = 'evil@x.co'`)).rejects.toThrow(/permission denied/)
    await db.query(`update update_requests set status = 'revoked'`)
    await db.query(`update approval_requests set status = 'revoked'`)
    expect((await db.query<{ status: string }>(`select status from update_requests`)).rows[0].status).toBe('revoked')
    // a revoked request cannot be changed again
    await db.query(`update update_requests set status = 'revoked'`)
    await as.asSuperuser()
    expect((await db.query<{ n: number }>(`select count(*)::int n from update_requests where status = 'revoked'`)).rows[0].n).toBe(1)
  })

  it("another user sees none and cannot revoke someone else's", async () => {
    await seedRequests()
    await as.asUser(B)
    expect(await count('update_requests')).toBe(0)
    await db.query(`update update_requests set status = 'revoked'`)
    await as.asSuperuser()
    expect((await db.query<{ status: string }>(`select status from update_requests`)).rows[0].status).toBe('pending')
  })

  it('token hashes must look like sha256 hex and be unique; requests go with their row', async () => {
    await seedRequests()
    await as.asSuperuser()
    const ins = (hash: string) =>
      db.query(
        `insert into update_requests (sheet_id, row_id, owner_id, workspace_id, token_hash, recipient_email, column_ids, expires_at) values ($1, $2, $3, $3, $4, 'a@b.co', '["x"]', now())`,
        [SHEET, R1, A, hash],
      )
    await expect(ins('not-a-hash')).rejects.toThrow()
    await expect(ins(HASH)).rejects.toThrow(/duplicate key/)
    await expect(db.query(`insert into update_requests (sheet_id, row_id, owner_id, workspace_id, token_hash, recipient_email, column_ids, expires_at) values ($1, $2, $3, $3, $4, 'a@b.co', '[]', now())`, [SHEET, R1, A, 'd'.repeat(64)])).rejects.toThrow()
    await db.query(`delete from rows where id = $1`, [R1])
    expect(await count('update_requests')).toBe(0)
    expect(await count('approval_requests')).toBe(0)
  })

  it('anon cannot read or write any automation table or call the function', async () => {
    await as.asAnon()
    for (const t of ['automation_rules', 'automation_runs', 'notifications', 'update_requests', 'approval_requests', 'row_locks']) {
      await expect(db.query(`select 1 from ${t}`)).rejects.toThrow(/permission denied/)
      await expect(db.query(`insert into ${t} default values`)).rejects.toThrow(/permission denied/)
    }
    await expect(db.query(`select copy_row_to_sheet($1, $2, 'a0', false)`, [R1, SHEET2])).rejects.toThrow(/permission denied/)
  })
})

describe('row_locks', () => {
  it('locks a row for its owner, once, and goes with the row', async () => {
    await db.query(`insert into row_locks (row_id, sheet_id) values ($1, $2)`, [R1, SHEET])
    await expect(db.query(`insert into row_locks (row_id, sheet_id) values ($1, $2)`, [R1, SHEET])).rejects.toThrow(/duplicate key/)
    await expect(db.query(`insert into row_locks (row_id, sheet_id) values ($1, $2)`, [R2, SHEET2])).rejects.toThrow() // R2 is not a row of SHEET2
    await as.asUser(B)
    expect(await count('row_locks')).toBe(0)
    await expect(db.query(`insert into row_locks (row_id, sheet_id) values ($1, $2)`, [R2, SHEET])).rejects.toThrow()
    await as.asUser(A)
    await db.query(`delete from rows where id = $1`, [R1])
    expect(await count('row_locks')).toBe(0)
  })
})

describe('copy_row_to_sheet', () => {
  const copy = async (row = R1, target = SHEET2, pos = 'a0', move = false) =>
    (await db.query<{ id: string }>(`select copy_row_to_sheet($1, $2, $3, $4) as id`, [row, target, pos, move])).rows[0].id

  it('copies cells between same-titled, same-typed columns (title case ignored) and leaves the original', async () => {
    const id = await copy()
    const r = await db.query<{ sheet_id: string; owner_id: string; cells: Record<string, unknown>; parent_id: string | null }>(`select sheet_id, owner_id, cells, parent_id from rows where id = $1`, [id])
    expect(r.rows[0].sheet_id).toBe(SHEET2)
    expect(r.rows[0].owner_id).toBe(A)
    expect(r.rows[0].parent_id).toBeNull()
    expect(r.rows[0].cells).toEqual({ [T_TASK]: 'Pour slab', [T_DATE]: '2026-11-20' }) // no predecessor, no "Other"
    expect(await count('rows')).toBe(3)
  })

  it('move deletes the original in the same statement', async () => {
    await copy(R1, SHEET2, 'a0', true)
    expect(await count('rows')).toBe(2)
    expect((await db.query(`select 1 from rows where id = $1`, [R1])).rows).toHaveLength(0)
  })

  it('refuses a row with sub-rows, the same sheet, an unknown row and other users sheets', async () => {
    await db.query(`insert into rows (sheet_id, parent_id, position) values ($1, $2, 'b0')`, [SHEET, R1])
    await expect(copy(R1)).rejects.toThrow(/sub-rows/)
    await expect(copy(R2, SHEET)).rejects.toThrow(/different sheet/)
    await expect(copy('aaaaaaaa-0000-0000-0000-00000000ffff')).rejects.toThrow(/row not found/)
    await expect(copy(R2, SHEET_B)).rejects.toThrow(/target sheet not found/)
    await as.asUser(B)
    await expect(copy(R2, SHEET_B)).rejects.toThrow(/row not found/) // A's row is invisible to B
  })

  it('works for the server (no auth.uid) and gives the new row the source row owner', async () => {
    await as.asSuperuser()
    const id = await copy(R1, SHEET2, 'a1', true)
    const r = await db.query<{ owner_id: string; workspace_id: string }>(`select owner_id, workspace_id from rows where id = $1`, [id])
    expect(r.rows[0]).toEqual({ owner_id: A, workspace_id: A })
  })
})
