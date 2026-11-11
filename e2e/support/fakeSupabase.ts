/**
 * In-memory fake of the slice of supabase-js that the app uses, for the Playwright E2E suite.
 *
 * It is swapped in for `createSupabaseClient` only when Vite runs in mode `e2e` (see
 * `vite.config.ts`); the production bundle never contains it (`scripts/check-bundle.mjs`).
 *
 * What it models:
 * - auth: email + password users, one persisted session, auth state events.
 * - tables `sheets`, `columns`, `rows`, `dependencies` with the schema's defaults, not-null
 *   columns, foreign keys and cascade deletes (supabase/migrations/0001_schema.sql).
 * - ownership: every read and write is limited to rows owned by the signed-in user, and
 *   inserts/updates must keep `owner_id` = that user and point at the user's own sheet.
 *
 * This mimics RLS ownership so the UI flows behave as they would against Supabase. It is NOT a
 * security test: the real row-level security policies are covered by the PGlite tests in
 * `src/db/rls.test.ts`.
 *
 * State lives in one JSON value in the given storage (localStorage in the browser), so a page
 * reload keeps both the data and the session. Any call the fake does not implement throws
 * `Error('fakeSupabase: unsupported call ...')` so gaps show up loudly.
 */

export const FAKE_STORAGE_KEY = 'fakeSupabase:v1'

export type TableName = 'sheets' | 'columns' | 'rows' | 'dependencies'
export type DbRecord = Record<string, unknown>

export interface FakeUser {
  id: string
  email: string
  password: string
  created_at: string
}

export interface FakeState {
  users: FakeUser[]
  /** Id of the signed-in user, or null. */
  sessionUserId: string | null
  tables: Record<TableName, DbRecord[]>
  /** Last `created_at` handed out, so timestamps are strictly increasing. */
  clock: number
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface FakeError {
  message: string
  code?: string
  details?: string | null
  hint?: string | null
  status?: number
  name?: string
}

export interface FakeResult<T = unknown> {
  data: T
  error: FakeError | null
}

const TABLES: readonly TableName[] = ['sheets', 'columns', 'rows', 'dependencies']

/** PostgREST's default `max-rows` on Supabase: the most rows one response returns. */
export const MAX_ROWS = 1000

const DEFAULT_CALENDAR = { workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [], hoursPerDay: 8 }

/** Columns of each table, with what a missing value becomes on insert. */
interface ColumnSpec {
  /** Default when the column is omitted; a function is evaluated per row. */
  default?: (ctx: { uid: string; now: () => string }) => unknown
  notNull?: boolean
}

const SCHEMA: Record<TableName, Record<string, ColumnSpec>> = {
  sheets: {
    id: { default: () => crypto.randomUUID(), notNull: true },
    owner_id: { default: ({ uid }) => uid, notNull: true },
    workspace_id: { default: ({ uid }) => uid, notNull: true },
    name: { notNull: true },
    calendar: { default: () => structuredClone(DEFAULT_CALENDAR), notNull: true },
    dependencies_enabled: { default: () => false, notNull: true },
    created_at: { default: ({ now }) => now(), notNull: true },
  },
  columns: {
    id: { default: () => crypto.randomUUID(), notNull: true },
    sheet_id: { notNull: true },
    owner_id: { default: ({ uid }) => uid, notNull: true },
    workspace_id: { default: ({ uid }) => uid, notNull: true },
    title: { notNull: true },
    type: { notNull: true },
    position: { notNull: true },
    options: { default: () => null },
    system_type: { default: () => null },
    role: { default: () => null },
    width: { default: () => null },
  },
  rows: {
    id: { default: () => crypto.randomUUID(), notNull: true },
    sheet_id: { notNull: true },
    owner_id: { default: ({ uid }) => uid, notNull: true },
    workspace_id: { default: ({ uid }) => uid, notNull: true },
    parent_id: { default: () => null },
    position: { notNull: true },
    cells: { default: () => ({}), notNull: true },
    version: { default: () => 0, notNull: true },
  },
  dependencies: {
    id: { default: () => crypto.randomUUID(), notNull: true },
    sheet_id: { notNull: true },
    owner_id: { default: ({ uid }) => uid, notNull: true },
    workspace_id: { default: ({ uid }) => uid, notNull: true },
    predecessor_row_id: { notNull: true },
    successor_row_id: { notNull: true },
    type: { notNull: true },
    lag_minutes: { default: () => 0, notNull: true },
  },
}

const COLUMN_TYPES = ['TEXT_NUMBER', 'DATE', 'CHECKBOX', 'PICKLIST', 'MULTI_PICKLIST', 'CONTACT_LIST', 'DURATION', 'PREDECESSOR']
const COLUMN_ROLES = ['start', 'end', 'duration', 'predecessor', 'percentComplete', 'status']
const DEP_TYPES = ['FS', 'SS', 'FF', 'SF']

export function emptyState(): FakeState {
  return { users: [], sessionUserId: null, tables: { sheets: [], columns: [], rows: [], dependencies: [] }, clock: 0 }
}

/** Adds a user to a state object (for seeding). Returns the new user. */
export function addUser(state: FakeState, email: string, password: string): FakeUser {
  const user: FakeUser = { id: crypto.randomUUID(), email: email.toLowerCase(), password, created_at: new Date().toISOString() }
  state.users.push(user)
  return user
}

function unsupported(what: string): never {
  throw new Error(`fakeSupabase: unsupported call ${what}`)
}

/** Keys that runtimes and test tooling probe on arbitrary objects; reading them must not throw. */
const INTROSPECTION_KEYS = new Set(['toJSON', 'constructor', '$$typeof', 'asymmetricMatch', 'nodeType', 'tagName', 'then'])

/** Wraps an object so reading any property it does not define throws a loud error. */
function strict<T extends object>(target: T, label: string): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === 'symbol' || prop in obj) return Reflect.get(obj, prop, receiver)
      if (INTROSPECTION_KEYS.has(prop)) return undefined
      return unsupported(`${label}.${prop}`)
    },
  })
}

const pgError = (message: string, code: string, details: string | null = null): FakeError => ({
  message,
  code,
  details,
  hint: null,
})

const rlsError = (table: TableName) => pgError(`new row violates row-level security policy for table "${table}"`, '42501')

type Filter = (row: DbRecord) => boolean

/** Parses PostgREST's list syntax `(a,b,"c")` as used by `.not(col, 'in', ...)`. */
function parseList(list: string): string[] {
  const m = /^\((.*)\)$/.exec(list.trim())
  if (!m) unsupported(`not(..., 'in', ${JSON.stringify(list)}) without a (a,b) list`)
  if (m[1].trim() === '') return []
  return m[1].split(',').map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
}

/** Checks a select list: `*` or plain column names (no embedding, aliases or casts). */
function checkColumns(columns: string): void {
  const cols = columns.split(',').map((c) => c.trim())
  if (cols.length === 1 && cols[0] === '*') return
  for (const c of cols) {
    if (!/^[a-z_]+$/.test(c)) unsupported(`select(${JSON.stringify(columns)}) (only * or plain column lists are supported)`)
  }
}

function project(row: DbRecord, columns: string): DbRecord {
  const cols = columns.split(',').map((c) => c.trim())
  if (cols.length === 1 && cols[0] === '*') return structuredClone(row)
  const out: DbRecord = {}
  for (const c of cols) out[c] = structuredClone(row[c])
  return out
}

export interface FakeSupabaseOptions {
  storage: StorageLike
  key?: string
}

type AuthEvent = 'INITIAL_SESSION' | 'SIGNED_IN' | 'SIGNED_OUT'
type AuthCallback = (event: AuthEvent, session: FakeSession | null) => void

export interface FakeSession {
  access_token: string
  refresh_token: string
  token_type: 'bearer'
  expires_in: number
  expires_at: number
  user: { id: string; email: string; aud: 'authenticated'; role: 'authenticated'; created_at: string }
}

/**
 * Creates the fake client. Typed loosely: the app casts it to `SupabaseClient`, and only the
 * methods implemented here may be used.
 */
export function createFakeSupabase({ storage, key = FAKE_STORAGE_KEY }: FakeSupabaseOptions) {
  function read(): FakeState {
    const raw = storage.getItem(key)
    if (!raw) return emptyState()
    const parsed = JSON.parse(raw) as FakeState
    for (const t of TABLES) parsed.tables[t] ??= []
    parsed.clock ??= 0
    return parsed
  }
  function write(state: FakeState): void {
    storage.setItem(key, JSON.stringify(state))
  }

  function sessionFor(user: FakeUser): FakeSession {
    const expiresIn = 3600
    return {
      access_token: `fake-access-token-${user.id}`,
      refresh_token: `fake-refresh-token-${user.id}`,
      token_type: 'bearer',
      expires_in: expiresIn,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      user: { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated', created_at: user.created_at },
    }
  }

  function currentSession(state: FakeState): FakeSession | null {
    const user = state.users.find((u) => u.id === state.sessionUserId)
    return user ? sessionFor(user) : null
  }

  const listeners = new Set<AuthCallback>()
  function emit(event: AuthEvent, session: FakeSession | null): void {
    for (const cb of [...listeners]) cb(event, session)
  }

  /** Real calls go over the network; resolve on a later task so callers cannot rely on sync results. */
  const tick = () => new Promise<void>((r) => setTimeout(r, 0))

  const authError = (message: string, status = 400): FakeError => ({ message, status, name: 'AuthApiError' })

  const auth = strict(
    {
      async getSession(): Promise<FakeResult<{ session: FakeSession | null }>> {
        await tick()
        return { data: { session: currentSession(read()) }, error: null }
      },

      onAuthStateChange(cb: AuthCallback) {
        listeners.add(cb)
        // supabase-js reports the current session to each new subscriber asynchronously.
        void tick().then(() => {
          if (listeners.has(cb)) cb('INITIAL_SESSION', currentSession(read()))
        })
        const subscription = strict(
          {
            id: crypto.randomUUID(),
            callback: cb,
            unsubscribe: () => {
              listeners.delete(cb)
            },
          },
          'auth.onAuthStateChange().subscription',
        )
        return { data: { subscription } }
      },

      async signInWithPassword(creds: { email: string; password: string }) {
        if (!creds || typeof creds.email !== 'string') unsupported('auth.signInWithPassword without an email')
        await tick()
        const state = read()
        const user = state.users.find((u) => u.email === creds.email.trim().toLowerCase())
        if (!user || user.password !== creds.password) {
          return { data: { user: null, session: null }, error: authError('Invalid login credentials') }
        }
        state.sessionUserId = user.id
        write(state)
        const session = sessionFor(user)
        emit('SIGNED_IN', session)
        return { data: { user: session.user, session }, error: null }
      },

      /** Behaves like a project with email confirmation turned off: sign-up signs the user in. */
      async signUp(creds: { email: string; password: string }) {
        if (!creds || typeof creds.email !== 'string') unsupported('auth.signUp without an email')
        await tick()
        const state = read()
        const email = creds.email.trim().toLowerCase()
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return { data: { user: null, session: null }, error: authError('Unable to validate email address: invalid format') }
        }
        if ((creds.password ?? '').length < 6) {
          return { data: { user: null, session: null }, error: authError('Password should be at least 6 characters.', 422) }
        }
        if (state.users.some((u) => u.email === email)) {
          return { data: { user: null, session: null }, error: authError('User already registered', 422) }
        }
        const user = addUser(state, email, creds.password)
        state.sessionUserId = user.id
        write(state)
        const session = sessionFor(user)
        emit('SIGNED_IN', session)
        return { data: { user: session.user, session }, error: null }
      },

      async signOut() {
        await tick()
        const state = read()
        state.sessionUserId = null
        write(state)
        emit('SIGNED_OUT', null)
        return { error: null }
      },
    },
    'auth',
  )

  function from(table: string) {
    if (!(TABLES as readonly string[]).includes(table)) unsupported(`from(${JSON.stringify(table)})`)
    return new QueryBuilder(table as TableName)
  }

  type Op =
    | { kind: 'select'; columns: string }
    | { kind: 'insert'; rows: DbRecord[] }
    | { kind: 'update'; patch: DbRecord }
    | { kind: 'delete' }

  /**
   * One query, built by chaining and run when awaited (like supabase-js's PostgrestBuilder).
   * Supports: select, insert, update, delete, eq, in, not(col, 'in', '(..)'), order, range, single,
   * and `.select(cols)` after a write to return the written rows.
   */
  class QueryBuilder {
    private op: Op | null = null
    private returning: string | null = null
    private filters: Filter[] = []
    private orders: { col: string; ascending: boolean }[] = []
    private wantSingle = false
    private rangeFrom = 0
    private rangeTo: number | null = null
    private readonly table: TableName

    constructor(table: TableName) {
      this.table = table
      // Return a strict proxy so any unimplemented builder method fails loudly.
      return strict(this, `from(${JSON.stringify(table)})`)
    }

    private setOp(op: Op): this {
      if (this.op) unsupported(`${this.table}: ${op.kind}() after ${this.op.kind}()`)
      this.op = op
      return this
    }

    select(columns = '*', options?: unknown): this {
      if (options !== undefined) unsupported(`${this.table}.select(..., options)`)
      checkColumns(columns)
      if (this.op && this.op.kind !== 'select') {
        if (this.returning !== null) unsupported(`${this.table}: select() called twice`)
        this.returning = columns
        return this
      }
      return this.setOp({ kind: 'select', columns })
    }

    insert(values: DbRecord | DbRecord[], options?: unknown): this {
      if (options !== undefined) unsupported(`${this.table}.insert(..., options)`)
      return this.setOp({ kind: 'insert', rows: Array.isArray(values) ? values : [values] })
    }

    update(patch: DbRecord, options?: unknown): this {
      if (options !== undefined) unsupported(`${this.table}.update(..., options)`)
      return this.setOp({ kind: 'update', patch })
    }

    delete(options?: unknown): this {
      if (options !== undefined) unsupported(`${this.table}.delete(options)`)
      return this.setOp({ kind: 'delete' })
    }

    private needFilterable(name: string): void {
      if (!this.op || this.op.kind === 'insert') unsupported(`${this.table}.${name}() on ${this.op?.kind ?? 'no operation'}`)
    }

    eq(col: string, value: unknown): this {
      this.needFilterable('eq')
      this.filters.push((r) => r[col] === value)
      return this
    }

    in(col: string, values: readonly unknown[]): this {
      this.needFilterable('in')
      if (!Array.isArray(values)) unsupported(`${this.table}.in(${col}, non-array)`)
      const set = new Set(values)
      this.filters.push((r) => set.has(r[col]))
      return this
    }

    not(col: string, operator: string, value: unknown): this {
      this.needFilterable('not')
      if (operator !== 'in' || typeof value !== 'string') unsupported(`${this.table}.not(${col}, ${JSON.stringify(operator)}, ...)`)
      const set = new Set(parseList(value))
      // SQL: NULL NOT IN (...) is not true, so rows with a null value are excluded too.
      this.filters.push((r) => r[col] != null && !set.has(String(r[col])))
      return this
    }

    order(col: string, options: { ascending?: boolean } = {}): this {
      if (!this.op || this.op.kind !== 'select') unsupported(`${this.table}.order() on ${this.op?.kind ?? 'no operation'}`)
      const extra = Object.keys(options).filter((k) => k !== 'ascending')
      if (extra.length > 0) unsupported(`${this.table}.order(${col}, {${extra.join(', ')}})`)
      this.orders.push({ col, ascending: options.ascending ?? true })
      return this
    }

    /** PostgREST row range (inclusive); the response is still capped at MAX_ROWS. */
    range(from: number, to: number, options?: unknown): this {
      if (!this.op || this.op.kind !== 'select') unsupported(`${this.table}.range() on ${this.op?.kind ?? 'no operation'}`)
      if (options !== undefined) unsupported(`${this.table}.range(..., options)`)
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
        unsupported(`${this.table}.range(${from}, ${to})`)
      }
      this.rangeFrom = from
      this.rangeTo = to
      return this
    }

    single(): this {
      this.wantSingle = true
      return this
    }

    then<R1 = FakeResult, R2 = never>(
      onFulfilled?: ((value: FakeResult) => R1 | PromiseLike<R1>) | null,
      onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
    ): Promise<R1 | R2> {
      return this.execute().then(onFulfilled, onRejected)
    }

    private async execute(): Promise<FakeResult> {
      if (!this.op) unsupported(`${this.table}: awaited without select/insert/update/delete`)
      await tick()
      const state = read()
      const uid = state.sessionUserId
      if (!uid || !state.users.some((u) => u.id === uid)) {
        // The anon role has no grants on these tables.
        return { data: null, error: pgError(`permission denied for table ${this.table}`, '42501') }
      }
      let result: FakeResult
      switch (this.op.kind) {
        case 'select':
          result = this.runSelect(state, uid, this.op.columns)
          break
        case 'insert':
          result = this.runInsert(state, uid, this.op.rows)
          break
        case 'update':
          result = this.runUpdate(state, uid, this.op.patch)
          break
        case 'delete':
          result = this.runDelete(state, uid)
          break
      }
      if (!result.error && this.op.kind !== 'select') write(state)
      return this.shape(result)
    }

    /** Applies `.single()` and the no-`.select()` rule for writes (data is null). */
    private shape(result: FakeResult): FakeResult {
      if (result.error) return { data: null, error: result.error }
      const isWrite = this.op!.kind !== 'select'
      if (isWrite && this.returning === null) return { data: null, error: null }
      const rows = result.data as DbRecord[]
      if (this.wantSingle) {
        if (rows.length !== 1) {
          return {
            data: null,
            error: pgError(
              'JSON object requested, multiple (or no) rows returned',
              'PGRST116',
              `The result contains ${rows.length} rows`,
            ),
          }
        }
        return { data: rows[0], error: null }
      }
      return { data: rows, error: null }
    }

    /** Rows of this table the user may see (RLS `using owner_id = auth.uid()`), after filters. */
    private visible(state: FakeState, uid: string): DbRecord[] {
      return state.tables[this.table].filter((r) => r.owner_id === uid && this.filters.every((f) => f(r)))
    }

    private runSelect(state: FakeState, uid: string, columns: string): FakeResult {
      const rows = [...this.visible(state, uid)]
      if (this.orders.length > 0) {
        rows.sort((a, b) => {
          for (const { col, ascending } of this.orders) {
            const c = compare(a[col], b[col])
            if (c !== 0) return ascending ? c : -c
          }
          return 0
        })
      }
      // Like PostgREST with max-rows = 1000: a response never holds more than MAX_ROWS rows,
      // with or without .range(), so callers must page.
      const end = Math.min(this.rangeTo === null ? Infinity : this.rangeTo + 1, this.rangeFrom + MAX_ROWS)
      return { data: rows.slice(this.rangeFrom, end).map((r) => project(r, columns)), error: null }
    }

    private returned(rows: DbRecord[]): DbRecord[] {
      return this.returning === null ? [] : rows.map((r) => project(r, this.returning!))
    }

    /** RLS `with check` plus the foreign keys and checks of the schema. Null when the row is fine. */
    private checkRow(state: FakeState, uid: string, row: DbRecord, pending: DbRecord[] = []): FakeError | null {
      const spec = SCHEMA[this.table]
      for (const col of Object.keys(row)) {
        if (!(col in spec)) return pgError(`Could not find the '${col}' column of '${this.table}' in the schema cache`, 'PGRST204')
      }
      for (const [col, s] of Object.entries(spec)) {
        if (s.notNull && row[col] == null) {
          return pgError(`null value in column "${col}" of relation "${this.table}" violates not-null constraint`, '23502')
        }
      }
      if (row.owner_id !== uid) return rlsError(this.table)
      if (this.table !== 'sheets') {
        const sheet = state.tables.sheets.find((s) => s.id === row.sheet_id)
        if (!sheet) return pgError(`insert or update on table "${this.table}" violates foreign key constraint`, '23503')
        if (sheet.owner_id !== uid) return rlsError(this.table)
      }
      const rowExists = (id: unknown) =>
        state.tables.rows.some((r) => r.id === id) || (this.table === 'rows' && pending.some((r) => r.id === id))
      if (this.table === 'columns') {
        if (!COLUMN_TYPES.includes(String(row.type))) return pgError('new row violates check constraint "columns_type_check"', '23514')
        if (row.role != null && !COLUMN_ROLES.includes(String(row.role))) {
          return pgError('new row violates check constraint "columns_role_check"', '23514')
        }
      }
      if (this.table === 'rows' && row.parent_id != null && !rowExists(row.parent_id)) {
        return pgError('insert or update on table "rows" violates foreign key constraint "rows_parent_id_fkey"', '23503')
      }
      if (this.table === 'dependencies') {
        if (!rowExists(row.predecessor_row_id) || !rowExists(row.successor_row_id)) {
          return pgError('insert or update on table "dependencies" violates foreign key constraint', '23503')
        }
        if (!DEP_TYPES.includes(String(row.type))) return pgError('new row violates check constraint "dependencies_type_check"', '23514')
        if (row.predecessor_row_id === row.successor_row_id) {
          return pgError('new row violates check constraint "dependencies_check"', '23514')
        }
      }
      return null
    }

    private runInsert(state: FakeState, uid: string, values: DbRecord[]): FakeResult {
      const now = () => {
        state.clock = Math.max(Date.now(), state.clock + 1)
        return new Date(state.clock).toISOString()
      }
      const spec = SCHEMA[this.table]
      const fresh: DbRecord[] = []
      for (const v of values) {
        const row: DbRecord = structuredClone(v)
        for (const [col, s] of Object.entries(spec)) {
          if (row[col] === undefined && s.default) row[col] = s.default({ uid, now })
        }
        fresh.push(row)
      }
      // The whole statement fails if any row fails (one statement, one transaction).
      const ids = new Set(state.tables[this.table].map((r) => r.id))
      for (const row of fresh) {
        if (ids.has(row.id)) {
          return { data: null, error: pgError(`duplicate key value violates unique constraint "${this.table}_pkey"`, '23505') }
        }
        ids.add(row.id)
        const err = this.checkRow(state, uid, row, fresh)
        if (err) return { data: null, error: err }
      }
      state.tables[this.table].push(...fresh)
      return { data: this.returned(fresh), error: null }
    }

    private runUpdate(state: FakeState, uid: string, patch: DbRecord): FakeResult {
      const targets = this.visible(state, uid)
      const updated = targets.map((r) => ({ ...r, ...structuredClone(patch) }))
      for (const row of updated) {
        const err = this.checkRow(state, uid, row)
        if (err) return { data: null, error: err }
      }
      const byId = new Map(updated.map((r) => [r.id, r]))
      state.tables[this.table] = state.tables[this.table].map((r) => byId.get(r.id) ?? r)
      return { data: this.returned(updated), error: null }
    }

    private runDelete(state: FakeState, uid: string): FakeResult {
      const targets = this.visible(state, uid)
      removeWithCascade(state, this.table, new Set(targets.map((r) => r.id)))
      return { data: this.returned(targets), error: null }
    }
  }

  const client = { auth, from }
  return strict(client, 'client')
}

export type FakeSupabaseClient = ReturnType<typeof createFakeSupabase>

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0
  // Postgres sorts NULLs last in ascending order.
  if (a == null) return 1
  if (b == null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

/** Deletes rows of `table` and everything that cascades from them (the schema's `on delete cascade`). */
function removeWithCascade(state: FakeState, table: TableName, ids: Set<unknown>): void {
  if (ids.size === 0) return
  if (table === 'sheets') {
    state.tables.sheets = state.tables.sheets.filter((r) => !ids.has(r.id))
    state.tables.columns = state.tables.columns.filter((r) => !ids.has(r.sheet_id))
    state.tables.dependencies = state.tables.dependencies.filter((r) => !ids.has(r.sheet_id))
    state.tables.rows = state.tables.rows.filter((r) => !ids.has(r.sheet_id))
    return
  }
  if (table === 'rows') {
    // Children cascade through parent_id, recursively.
    const all = new Set(ids)
    let grew = true
    while (grew) {
      grew = false
      for (const r of state.tables.rows) {
        if (r.parent_id != null && all.has(r.parent_id) && !all.has(r.id)) {
          all.add(r.id)
          grew = true
        }
      }
    }
    state.tables.rows = state.tables.rows.filter((r) => !all.has(r.id))
    state.tables.dependencies = state.tables.dependencies.filter(
      (d) => !all.has(d.predecessor_row_id) && !all.has(d.successor_row_id),
    )
    return
  }
  state.tables[table] = state.tables[table].filter((r) => !ids.has(r.id))
}
