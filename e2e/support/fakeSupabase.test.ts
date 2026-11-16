// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeSupabase, FAKE_STORAGE_KEY, type FakeState, type StorageLike } from './fakeSupabase'

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

const A = { email: 'e2e-user-a@example.com', password: 'e2e-password-a' }
const B = { email: 'e2e-user-b@example.com', password: 'e2e-password-b' }

describe('fakeSupabase auth', () => {
  let storage: ReturnType<typeof memoryStorage>
  let client: ReturnType<typeof createFakeSupabase>
  beforeEach(() => {
    storage = memoryStorage()
    client = createFakeSupabase({ storage })
  })

  it('signs up (signed in at once), signs out and signs in again', async () => {
    const events: string[] = []
    const { data: sub } = client.auth.onAuthStateChange((e) => events.push(e))
    const up = await client.auth.signUp(A)
    expect(up.error).toBeNull()
    expect(up.data.session?.user.email).toBe(A.email)
    expect((await client.auth.getSession()).data.session?.user.id).toBe(up.data.user?.id)

    expect((await client.auth.signOut()).error).toBeNull()
    expect((await client.auth.getSession()).data.session).toBeNull()

    const inRes = await client.auth.signInWithPassword(A)
    expect(inRes.error).toBeNull()
    expect(inRes.data.session?.user.id).toBe(up.data.user?.id)
    expect(events).toEqual(['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT', 'SIGNED_IN'])
    sub.subscription.unsubscribe()
  })

  it('rejects a wrong password and a duplicate sign-up', async () => {
    await client.auth.signUp(A)
    await client.auth.signOut()
    const bad = await client.auth.signInWithPassword({ email: A.email, password: 'nope-nope' })
    expect(bad.error?.message).toBe('Invalid login credentials')
    expect(bad.data.session).toBeNull()
    const dup = await client.auth.signUp(A)
    expect(dup.error?.message).toBe('User already registered')
  })

  it('reports the current session to a new subscriber asynchronously, and not after unsubscribe', async () => {
    await client.auth.signUp(A)
    const seen: (string | undefined)[] = []
    client.auth.onAuthStateChange((_e, s) => seen.push(s?.user.email))
    expect(seen).toEqual([])
    await new Promise((r) => setTimeout(r, 5))
    expect(seen).toEqual([A.email])

    const late: string[] = []
    const { data } = client.auth.onAuthStateChange((e) => late.push(e))
    data.subscription.unsubscribe()
    await new Promise((r) => setTimeout(r, 5))
    expect(late).toEqual([])
  })

  it('keeps users, data and the session in storage (a new client sees them)', async () => {
    await client.auth.signUp(A)
    await client.from('sheets').insert({ name: 'Kept' })
    const again = createFakeSupabase({ storage })
    expect((await again.auth.getSession()).data.session?.user.email).toBe(A.email)
    const { data } = await again.from('sheets').select('name')
    expect(data).toEqual([{ name: 'Kept' }])
    expect(JSON.parse(storage.map.get(FAKE_STORAGE_KEY)!).users).toHaveLength(1)
  })
})

describe('fakeSupabase tables', () => {
  let storage: ReturnType<typeof memoryStorage>
  let client: ReturnType<typeof createFakeSupabase>
  let uid: string
  beforeEach(async () => {
    storage = memoryStorage()
    client = createFakeSupabase({ storage })
    uid = (await client.auth.signUp(A)).data.user!.id
  })

  async function newSheet(name = 'S'): Promise<string> {
    const { data, error } = await client.from('sheets').insert({ name }).select('id').single()
    expect(error).toBeNull()
    return (data as { id: string }).id
  }

  it('fills schema defaults on insert and returns rows only with .select()', async () => {
    const plain = await client.from('sheets').insert({ name: 'No return' })
    expect(plain).toEqual({ data: null, error: null })
    const { data } = await client.from('sheets').insert({ name: 'X' }).select('*').single()
    const row = data as Record<string, unknown>
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.owner_id).toBe(uid)
    expect(row.workspace_id).toBe(uid)
    expect(row.dependencies_enabled).toBe(false)
    expect(row.calendar).toEqual({ workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 })
    expect(typeof row.created_at).toBe('string')

    const sheetId = row.id as string
    const r = await client.from('rows').insert({ sheet_id: sheetId, position: 'a0' }).select('*').single()
    expect(r.data).toMatchObject({ parent_id: null, cells: {}, version: 0, owner_id: uid })
  })

  it('upserts on id and on the dependency pair, and enforces one dependency per pair and same-sheet endpoints', async () => {
    const s = await newSheet()
    const other = await newSheet('Other')
    const [r1, r2, r3] = [1, 2, 3].map((i) => `00000000-0000-4000-8000-00000000000${i}`)
    // upsert on id: insert, then the same id again updates instead of failing.
    expect((await client.from('rows').upsert({ id: r1, sheet_id: s, position: 'a0' }, { onConflict: 'id' })).error).toBeNull()
    expect((await client.from('rows').upsert({ id: r1, sheet_id: s, position: 'a5' }, { onConflict: 'id' })).error).toBeNull()
    expect((await client.from('rows').select('position').eq('id', r1)).data).toEqual([{ position: 'a5' }])
    await client.from('rows').insert([
      { id: r2, sheet_id: s, position: 'a1' },
      { id: r3, sheet_id: other, position: 'a0' },
    ])

    const pair = 'sheet_id,predecessor_row_id,successor_row_id'
    const dep = { sheet_id: s, predecessor_row_id: r1, successor_row_id: r2, type: 'FS', lag_minutes: 0 }
    const first = await client.from('dependencies').upsert(dep, { onConflict: pair }).select('id, type')
    expect(first.error).toBeNull()
    const again = await client.from('dependencies').upsert({ ...dep, type: 'SS' }, { onConflict: pair }).select('id, type')
    expect(again.data).toEqual([{ id: (first.data as { id: string }[])[0].id, type: 'SS' }])
    expect((await client.from('dependencies').select('id')).data).toHaveLength(1)

    const dup = await client.from('dependencies').insert({ ...dep, type: 'FF' })
    expect(dup.error?.code).toBe('23505')
    const twice = await client.from('dependencies').upsert([dep, dep], { onConflict: pair })
    expect(twice.error?.code).toBe('21000')
    const crossSheet = await client.from('dependencies').insert({ ...dep, successor_row_id: r3 })
    expect(crossSheet.error?.code).toBe('23503')
    const crossParent = await client.from('rows').insert({ sheet_id: other, parent_id: r1, position: 'b0' })
    expect(crossParent.error?.code).toBe('23503')
  })

  it('caps a select without a range at 1000 rows and pages with .range(from, to) like PostgREST', async () => {
    const s = await newSheet()
    const ids = Array.from({ length: 1201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const ins = await client.from('rows').insert(ids.map((id, i) => ({ id, sheet_id: s, position: `a${i}` })))
    expect(ins.error).toBeNull()
    const capped = (await client.from('rows').select('id').eq('sheet_id', s)).data as { id: string }[]
    expect(capped).toHaveLength(1000)
    const page2 = (await client.from('rows').select('id').eq('sheet_id', s).order('id').range(1000, 1999)).data as { id: string }[]
    expect(page2.map((r) => r.id)).toEqual(ids.slice(1000))
    const small = (await client.from('rows').select('id').eq('sheet_id', s).order('id').range(5, 7)).data as { id: string }[]
    expect(small.map((r) => r.id)).toEqual(ids.slice(5, 8))
    // A range wider than the cap is still capped.
    const wide = (await client.from('rows').select('id').eq('sheet_id', s).order('id').range(0, 4999)).data as unknown[]
    expect(wide).toHaveLength(1000)
  })

  it('selects with eq, in, not in, order and column lists', async () => {
    const s = await newSheet()
    await client.from('columns').insert([
      { sheet_id: s, title: 'B', type: 'TEXT_NUMBER', position: 1 },
      { sheet_id: s, title: 'A', type: 'DATE', position: 0 },
      { sheet_id: s, title: 'C', type: 'DURATION', position: 2 },
    ])
    const ordered = await client.from('columns').select('title, position').eq('sheet_id', s).order('position', { ascending: true })
    expect(ordered.data).toEqual([
      { title: 'A', position: 0 },
      { title: 'B', position: 1 },
      { title: 'C', position: 2 },
    ])
    const desc = await client.from('columns').select('title').eq('sheet_id', s).order('position', { ascending: false })
    expect((desc.data as { title: string }[]).map((c) => c.title)).toEqual(['C', 'B', 'A'])

    const all = (await client.from('columns').select('id,title').eq('sheet_id', s)).data as { id: string; title: string }[]
    const idOf = (t: string) => all.find((c) => c.title === t)!.id
    const picked = await client.from('columns').select('title').in('id', [idOf('A'), idOf('C')]).order('title')
    expect(picked.data).toEqual([{ title: 'A' }, { title: 'C' }])
    await client.from('columns').delete().eq('sheet_id', s).not('id', 'in', `(${idOf('B')})`)
    expect((await client.from('columns').select('title')).data).toEqual([{ title: 'B' }])
  })

  it('orders sheets newest first even when created in the same millisecond', async () => {
    await newSheet('first')
    await newSheet('second')
    const { data } = await client.from('sheets').select('id,name,created_at').order('created_at', { ascending: false })
    expect((data as { name: string }[]).map((s) => s.name)).toEqual(['second', 'first'])
  })

  it('updates with .select().single() as persistence.saveCell does', async () => {
    const s = await newSheet()
    const { data: row } = await client.from('rows').insert({ sheet_id: s, position: 'a0' }).select('id').single()
    const id = (row as { id: string }).id
    const cur = await client.from('rows').select('cells, version').eq('id', id).single()
    expect(cur.data).toEqual({ cells: {}, version: 0 })
    const upd = await client.from('rows').update({ cells: { c1: 'x' }, version: 1 }).eq('id', id).select('version').single()
    expect(upd).toEqual({ data: { version: 1 }, error: null })
    const none = await client.from('rows').update({ version: 5 }).eq('id', 'missing').select('version').single()
    expect(none.error?.code).toBe('PGRST116')
  })

  it('.single() errors with PGRST116 when there is not exactly one row', async () => {
    const res = await client.from('sheets').select('*').eq('id', 'nope').single()
    expect(res.data).toBeNull()
    expect(res.error?.code).toBe('PGRST116')
  })

  it('cascades: deleting a row removes its children and their dependencies; deleting a sheet removes everything', async () => {
    const s = await newSheet()
    await client.from('columns').insert({ sheet_id: s, title: 'T', type: 'TEXT_NUMBER', position: 0 })
    const ins = async (position: string, parent_id: string | null = null) =>
      ((await client.from('rows').insert({ sheet_id: s, position, parent_id }).select('id').single()).data as { id: string }).id
    const parent = await ins('a0')
    const child = await ins('a1', parent)
    const other = await ins('a2')
    const dep = await client
      .from('dependencies')
      .insert({ sheet_id: s, predecessor_row_id: child, successor_row_id: other, type: 'FS' })
    expect(dep.error).toBeNull()

    await client.from('rows').delete().in('id', [parent])
    expect((await client.from('rows').select('id')).data).toEqual([{ id: other }])
    expect((await client.from('dependencies').select('id')).data).toEqual([])

    await client.from('sheets').delete().eq('id', s)
    for (const t of ['sheets', 'columns', 'rows', 'dependencies'] as const) {
      expect((await client.from(t).select('id')).data).toEqual([])
    }
  })

  it('enforces foreign keys, not-null columns, checks, and unique ids; a failing batch inserts nothing', async () => {
    const s = await newSheet()
    expect((await client.from('rows').insert({ sheet_id: 'missing-sheet', position: 'a0' })).error?.code).toBe('23503')
    expect((await client.from('rows').insert({ sheet_id: s })).error?.code).toBe('23502')
    expect((await client.from('columns').insert({ sheet_id: s, title: 'X', type: 'NOPE', position: 0 })).error?.code).toBe('23514')
    const res = await client.from('rows').insert([
      { sheet_id: s, position: 'a0' },
      { sheet_id: s, position: 'a1', parent_id: 'missing-row' },
    ])
    expect(res.error?.code).toBe('23503')
    expect((await client.from('rows').select('id')).data).toEqual([])
    const id = crypto.randomUUID()
    await client.from('rows').insert({ id, sheet_id: s, position: 'a0' })
    expect((await client.from('rows').insert({ id, sheet_id: s, position: 'a1' })).error?.code).toBe('23505')
    expect((await client.from('rows').insert({ sheet_id: s, position: 'a1', bogus: 1 })).error?.code).toBe('PGRST204')
  })

  it('accepts a parent row inserted earlier in the same batch', async () => {
    const s = await newSheet()
    const parent = crypto.randomUUID()
    const res = await client.from('rows').insert([
      { id: parent, sheet_id: s, position: 'a0' },
      { sheet_id: s, position: 'a1', parent_id: parent },
    ])
    expect(res.error).toBeNull()
  })

  it('limits every read and write to the signed-in owner (mimics RLS ownership; not a security test)', async () => {
    const aSheet = await newSheet('A sheet')
    await client.auth.signOut()
    const bId = (await client.auth.signUp(B)).data.user!.id

    expect((await client.from('sheets').select('*')).data).toEqual([])
    expect((await client.from('sheets').select('*').eq('id', aSheet).single()).error?.code).toBe('PGRST116')
    // Writing into A's sheet, or as A, is rejected.
    expect((await client.from('rows').insert({ sheet_id: aSheet, position: 'a0' })).error?.code).toBe('42501')
    expect((await client.from('sheets').insert({ name: 'spoof', owner_id: uid })).error?.code).toBe('42501')
    // Updates and deletes of A's rows touch nothing.
    await client.from('sheets').update({ name: 'hacked' }).eq('id', aSheet)
    await client.from('sheets').delete().eq('id', aSheet)
    // B cannot hand its own sheet over to A either.
    const bSheet = ((await client.from('sheets').insert({ name: 'B sheet' }).select('id').single()).data as { id: string }).id
    expect((await client.from('sheets').update({ owner_id: uid }).eq('id', bSheet)).error?.code).toBe('42501')

    await client.auth.signOut()
    await client.auth.signInWithPassword(A)
    expect((await client.from('sheets').select('name')).data).toEqual([{ name: 'A sheet' }])
    const state = JSON.parse(storage.map.get(FAKE_STORAGE_KEY)!) as FakeState
    expect(state.tables.sheets.find((s) => s.id === bSheet)?.owner_id).toBe(bId)
  })

  it('denies table access without a session', async () => {
    await client.auth.signOut()
    const res = await client.from('sheets').select('*')
    expect(res.error?.message).toBe('permission denied for table sheets')
  })

  it('throws loudly on anything it does not implement', async () => {
    expect(() => client.from('webhooks')).toThrow(/fakeSupabase: unsupported call from\("webhooks"\)/)
    const b = client.from('sheets') as unknown as Record<string, () => unknown>
    expect(() => b.rpc()).toThrow(/fakeSupabase: unsupported call .*rpc/)
    expect(() => client.from('sheets').upsert({ id: 'x' }, { onConflict: 'name' })).toThrow(/unsupported call .*onConflict/)
    expect(() => (client as unknown as Record<string, unknown>).storage).toThrow(/fakeSupabase: unsupported call client\.storage/)
    expect(() => (client.auth as unknown as Record<string, unknown>).getUser).toThrow(/unsupported call auth\.getUser/)
    expect(() => client.from('sheets').select('*').not('id', 'eq', 'x')).toThrow(/unsupported call/)
    expect(() => client.from('sheets').select('id, rows(id)')).toThrow(/unsupported call select/)
    expect(() => client.from('sheets').select('*', { count: 'exact' } as never)).toThrow(/unsupported call/)
  })

  it("rpc delete_column / set_column_cells touch only the caller's own column and rows", async () => {
    const s = await newSheet()
    const col = '00000000-0000-4000-8000-0000000000c1'
    const row = '00000000-0000-4000-8000-0000000000a1'
    await client.from('columns').insert({ id: col, sheet_id: s, title: 'X', type: 'TEXT_NUMBER', position: 0 })
    await client.from('rows').insert({ id: row, sheet_id: s, position: 'a0', cells: { [col]: 1, keep: 2 } })
    await expect(client.rpc('nope')).rejects.toThrow(/unsupported call rpc\("nope"\)/)

    await client.auth.signOut()
    await client.auth.signUp(B)
    expect(await client.rpc('set_column_cells', { p_sheet_id: s, p_column_id: col, p_values: { [row]: 'hacked' } })).toEqual({
      data: null,
      error: null,
    })
    await client.rpc('delete_column', { p_column_id: col })
    await client.auth.signOut()
    await client.auth.signInWithPassword(A)
    expect((await client.from('rows').select('cells').eq('id', row)).data).toEqual([{ cells: { [col]: 1, keep: 2 } }])

    await client.rpc('set_column_cells', { p_sheet_id: s, p_column_id: col, p_values: { [row]: [3] } })
    expect((await client.from('rows').select('cells').eq('id', row)).data).toEqual([{ cells: { [col]: [3], keep: 2 } }])
    await client.rpc('delete_column', { p_column_id: col })
    expect((await client.from('rows').select('cells').eq('id', row)).data).toEqual([{ cells: { keep: 2 } }])
    expect((await client.from('columns').select('id')).data).toEqual([])
  })
})

describe('fakeSupabase baselines', () => {
  let client: ReturnType<typeof createFakeSupabase>
  const R1 = '00000000-0000-4000-8000-0000000000a1'
  const R2 = '00000000-0000-4000-8000-0000000000a2'
  const rowsFor = (...ids: string[]) => ids.map((rowId, i) => ({ rowId, start: '2026-11-09', end: '2026-11-1' + i, durationDays: i + 1 }))

  beforeEach(async () => {
    client = createFakeSupabase({ storage: memoryStorage() })
    await client.auth.signUp(A)
  })

  async function newSheet(name = 'S'): Promise<string> {
    return ((await client.from('sheets').insert({ name }).select('id').single()).data as { id: string }).id
  }
  const save = (sheet: string, slot: number, name: string, rows: unknown[] = rowsFor(R1, R2)) =>
    client.rpc('save_baseline', { p_sheet_id: sheet, p_slot: slot, p_name: name, p_rows: rows })

  it('save_baseline returns the new id, stores header and rows, and replaces the slot', async () => {
    const s = await newSheet()
    const first = await save(s, 2, 'Agreed plan')
    expect(first.error).toBeNull()
    const id = first.data as string
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    const header = await client.from('baselines').select('id, slot, name, created_at').eq('sheet_id', s)
    expect(header.data).toEqual([{ id, slot: 2, name: 'Agreed plan', created_at: expect.any(String) }])
    const rows = await client.from('baseline_rows').select('*').eq('baseline_id', id).order('row_id')
    expect(rows.data).toMatchObject([
      { row_id: R1, start_date: '2026-11-09', end_date: '2026-11-10', duration_days: 1 },
      { row_id: R2, start_date: '2026-11-09', end_date: '2026-11-11', duration_days: 2 },
    ])

    const again = await save(s, 2, 'Revised', rowsFor(R1))
    expect(again.data).not.toBe(id)
    expect((await client.from('baselines').select('id, name').eq('sheet_id', s)).data).toEqual([{ id: again.data, name: 'Revised' }])
    expect((await client.from('baseline_rows').select('baseline_id')).data).toEqual([{ baseline_id: again.data }])
    await save(s, 3, 'Other slot')
    expect((await client.from('baselines').select('slot').eq('sheet_id', s).order('slot')).data).toEqual([{ slot: 2 }, { slot: 3 }])
  })

  it('save_baseline validates the slot, name and rows, and changes nothing on failure', async () => {
    const s = await newSheet()
    const kept = (await save(s, 1, 'Keep')).data as string
    const bad = [
      await save(s, 0, 'x'),
      await save(s, 6, 'x'),
      await save(s, 1.5, 'x'),
      await save(s, 1, '   '),
      await save(s, 1, 'n'.repeat(101)),
      await save(s, 1, 'x', [{ rowId: R1, start: '2026-11-10', end: '2026-11-09', durationDays: 1 }]),
      await save(s, 1, 'x', [{ rowId: R1, start: '2026-11-09', end: '2026-11-10', durationDays: -1 }]),
      await save(s, 1, 'x', [{ rowId: 'not-a-uuid', start: '2026-11-09', end: '2026-11-10', durationDays: 1 }]),
      await save(s, 1, 'x', [...rowsFor(R1), ...rowsFor(R1)]),
    ]
    for (const r of bad) {
      expect(r.data).toBeNull()
      expect(r.error?.message).toBeTruthy()
    }
    expect((await client.from('baselines').select('id')).data).toEqual([{ id: kept }])
    expect((await client.from('baseline_rows').select('baseline_id')).data).toHaveLength(2)
  })

  it("refuses another user's sheet and a missing sheet, and hides baselines from other users", async () => {
    const s = await newSheet()
    await save(s, 1, 'Mine')
    await client.auth.signOut()
    await client.auth.signUp(B)
    const theirs = await save(s, 1, 'Hack')
    expect(theirs.data).toBeNull()
    expect(theirs.error?.code).toBe('42501')
    expect((await save(crypto.randomUUID(), 1, 'x')).error?.code).toBe('42501')
    expect((await client.from('baselines').select('*')).data).toEqual([])
    expect((await client.from('baseline_rows').select('*')).data).toEqual([])
    expect((await client.from('baselines').delete().eq('sheet_id', s)).error).toBeNull()
    await client.auth.signOut()
    await client.auth.signInWithPassword(A)
    expect((await client.from('baselines').select('id')).data).toHaveLength(1)
  })

  it('deleting a baseline removes its rows; deleting a sheet removes its baselines; deleting a row keeps them', async () => {
    const s = await newSheet()
    await client.from('rows').insert({ sheet_id: s, position: 'a0', id: R1 })
    const a = (await save(s, 1, 'A')).data as string
    await save(s, 2, 'B')
    await client.from('rows').delete().in('id', [R1])
    expect((await client.from('baseline_rows').select('row_id').eq('baseline_id', a)).data).toHaveLength(2)

    expect((await client.from('baselines').delete().eq('id', a)).error).toBeNull()
    expect((await client.from('baselines').select('slot')).data).toEqual([{ slot: 2 }])
    expect((await client.from('baseline_rows').select('baseline_id').eq('baseline_id', a)).data).toEqual([])
    expect((await client.from('baseline_rows').select('baseline_id')).data).toHaveLength(2)

    await client.from('sheets').delete().eq('id', s)
    expect((await client.from('baselines').select('id')).data).toEqual([])
    expect((await client.from('baseline_rows').select('baseline_id')).data).toEqual([])
  })

  it('caps baseline_rows at 1000 per response and pages with .range()', async () => {
    const s = await newSheet()
    const many = Array.from({ length: 2500 }, (_, i) => ({
      rowId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      start: '2026-11-09',
      end: '2026-11-09',
      durationDays: 1,
    }))
    const id = (await save(s, 1, 'Big', many)).data as string
    const q = () => client.from('baseline_rows').select('row_id').eq('baseline_id', id).order('row_id')
    expect((await q()).data).toHaveLength(1000)
    expect((await q().range(1000, 1999)).data).toHaveLength(1000)
    expect((await q().range(2000, 2999)).data).toHaveLength(500)
  })

  it('enforces slot uniqueness and checks on direct inserts, and rejects updates of snapshot rows loudly', async () => {
    const s = await newSheet()
    expect((await client.from('baselines').insert({ sheet_id: s, slot: 1, name: 'a' })).error).toBeNull()
    expect((await client.from('baselines').insert({ sheet_id: s, slot: 1, name: 'b' })).error?.code).toBe('23505')
    expect((await client.from('baselines').insert({ sheet_id: s, slot: 9, name: 'b' })).error?.code).toBe('23514')
    expect((await client.from('baselines').insert({ sheet_id: s, slot: 2, name: '' })).error?.code).toBe('23514')
    const orphan = { baseline_id: crypto.randomUUID(), sheet_id: s, row_id: R1, start_date: '2026-11-09', end_date: '2026-11-09', duration_days: 1 }
    expect((await client.from('baseline_rows').insert(orphan)).error?.code).toBe('23503')
    expect(() => client.from('baseline_rows').update({ duration_days: 3 })).toThrow(/unsupported call .*baseline_rows.update/)
  })
})

describe('fakeSupabase smart assets (0008_assets.sql)', () => {
  let client: ReturnType<typeof createFakeSupabase>
  beforeEach(async () => {
    client = createFakeSupabase({ storage: memoryStorage() })
    await client.auth.signUp(A)
  })
  const id = async (table: string, row: Record<string, unknown>): Promise<string> => {
    const { data, error } = await client.from(table).insert(row).select('id').single()
    expect(error).toBeNull()
    return (data as { id: string }).id
  }
  const count = async (table: string) => ((await client.from(table).select('id')).data as unknown[]).length

  it('derives asset_type and kind, and allows one placement per asset and one star per target', async () => {
    const space = await id('workspaces', { name: 'W' })
    const report = await id('reports', { name: 'R', definition: { sources: [] } })
    const item = await client.from('workspace_items').insert({ space_id: space, report_id: report }).select('asset_type').single()
    expect(item.data).toEqual({ asset_type: 'report' })
    expect((await client.from('workspace_items').insert({ space_id: space, report_id: report })).error?.code).toBe('23505')
    expect((await client.from('workspace_items').insert({ space_id: space })).error?.code).toBe('23514')
    const star = await client.from('favorites').insert({ report_id: report }).select('kind').single()
    expect(star.data).toEqual({ kind: 'report' })
    expect((await client.from('favorites').insert({ report_id: report })).error?.code).toBe('23505')
  })

  it('checks names, json objects, folder parents, nesting depth and cycles', async () => {
    expect((await client.from('workspaces').insert({ name: '  ' })).error?.code).toBe('23514')
    expect((await client.from('reports').insert({ name: 'R', definition: [1] })).error?.code).toBe('23514')
    const w1 = await id('workspaces', { name: 'One' })
    const w2 = await id('workspaces', { name: 'Two' })
    const f1 = await id('folders', { space_id: w1, name: 'f1' })
    expect((await client.from('folders').insert({ space_id: w2, parent_id: f1, name: 'bad' })).error?.code).toBe('23503')
    let parent = f1
    for (let i = 2; i <= 5; i++) parent = await id('folders', { space_id: w1, parent_id: parent, name: `f${i}` })
    expect((await client.from('folders').insert({ space_id: w1, parent_id: parent, name: 'f6' })).error?.code).toBe('23514')
    expect((await client.from('folders').update({ parent_id: parent }).eq('id', f1)).error?.code).toBe('23514') // into its own subtree
    expect((await client.from('folders').update({ space_id: w2 }).eq('id', f1)).error?.code).toBe('23514') // never changes workspace
  })

  it('stamps updated_at on update and cascades deletes', async () => {
    const space = await id('workspaces', { name: 'W' })
    const folder = await id('folders', { space_id: space, name: 'F' })
    const dash = await id('dashboards', { name: 'D', layout: { widgets: [] } })
    const before = (await client.from('dashboards').select('updated_at').eq('id', dash).single()).data as { updated_at: string }
    await new Promise((r) => setTimeout(r, 3))
    await client.from('dashboards').update({ name: 'D2' }).eq('id', dash)
    const after = (await client.from('dashboards').select('updated_at').eq('id', dash).single()).data as { updated_at: string }
    expect(after.updated_at > before.updated_at).toBe(true)

    await client.from('workspace_items').insert({ space_id: space, folder_id: folder, dashboard_id: dash })
    await client.from('favorites').insert({ folder_id: folder })
    await client.from('folders').delete().eq('id', folder)
    expect([await count('workspace_items'), await count('favorites')]).toEqual([0, 0])
    expect(await count('dashboards')).toBe(1)
    await client.from('dashboards').delete().eq('id', dash)
    expect(await count('dashboards')).toBe(0)
  })

  it('a sheet delete removes its placement and star; another user sees nothing', async () => {
    const sheet = await id('sheets', { name: 'S' })
    const space = await id('workspaces', { name: 'W' })
    await client.from('workspace_items').insert({ space_id: space, sheet_id: sheet })
    await client.from('favorites').insert({ sheet_id: sheet })
    await client.from('sheets').delete().eq('id', sheet)
    expect([await count('workspace_items'), await count('favorites')]).toEqual([0, 0])

    await client.auth.signOut()
    await client.auth.signUp(B)
    expect([await count('workspaces'), await count('folders'), await count('reports')]).toEqual([0, 0, 0])
    expect((await client.from('workspace_items').insert({ space_id: space, sheet_id: crypto.randomUUID() })).error).not.toBeNull()
  })
})
