/**
 * In-memory fake of the slice of supabase-js that the app uses, for the Playwright E2E suite.
 *
 * It is swapped in for `createSupabaseClient` only when Vite runs in mode `e2e` (see
 * `vite.config.ts`); the production bundle never contains it (`scripts/check-bundle.mjs`).
 *
 * What it models:
 * - auth: email + password users, one persisted session, auth state events.
 * - tables `sheets`, `columns` (incl. `formula`, 0007_column_formula.sql), `rows`, `dependencies` with the schema's defaults, not-null
 *   columns, foreign keys and cascade deletes (supabase/migrations/0001_schema.sql), plus
 *   0002_hardening.sql's same-sheet parents/endpoints and one dependency per pair.
 * - PostgREST's 1000-row response cap (`.range()` pages), and `upsert` (ON CONFLICT DO UPDATE).
 * - the database functions `delete_column` and `set_column_cells` (0003_columns.sql), via `rpc`.
 * - tables `baselines` and `baseline_rows` and the function `save_baseline` (0006_baselines.sql):
 *   cascade on sheet delete, NO cascade from `rows` (a baseline outlives a deleted row).
 * - tables `resources`, `resource_time_off` and `assignments` (0010_resources.sql): their checks, the
 *   (resource, owner) foreign keys with cascade, one assignment per task and resource, and NO
 *   cascade from `rows` (an assignment outlives a deleted task).
 * - the smart-asset tables of 0008_assets.sql (workspaces, folders, reports, dashboards,
 *   workspace_items, favorites), in fakeAssets.ts.
 * - ownership: every read and write is limited to rows owned by the signed-in user, and
 *   inserts/updates must keep `owner_id` = that user and point at the user's own sheet.
 *
 * - the automation tables and `copy_row_to_sheet` (0009_automation.sql): see fakeAutomation.ts.
 *
 * This mimics RLS ownership so the UI flows behave as they would against Supabase. It is NOT a
 * security test: the real row-level security policies are covered by the PGlite tests in
 * `src/db/rls.test.ts`.
 *
 * State lives in one JSON value in the given storage (localStorage in the browser), so a page
 * reload keeps both the data and the session. Any call the fake does not implement throws
 * `Error('fakeSupabase: unsupported call ...')` so gaps show up loudly.
 */

import {
  AUTOMATION_SCHEMA,
  AUTOMATION_TABLES,
  automationAccessError,
  automationRowError,
  automationUniqueError,
  automationUpdatable,
  cascadeAutomation,
  copyRowToSheet,
  type AutomationTable,
} from './fakeAutomation'
import {
  ASSET_SCHEMA,
  ASSET_TABLES,
  assetRowError,
  assetUniqueError,
  beforeAssetUpdate,
  cascadeAssets,
  computeGenerated,
  isAssetTable,
  type AssetTable,
} from './fakeAssets'

export const FAKE_STORAGE_KEY = 'fakeSupabase:v1'

export type TableName =
  | 'sheets'
  | 'columns'
  | 'rows'
  | 'dependencies'
  | 'baselines'
  | 'baseline_rows'
  | 'resources'
  | 'resource_time_off'
  | 'assignments'
  | AutomationTable
  | AssetTable
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

const TABLES: readonly TableName[] = [
  'sheets',
  'columns',
  'rows',
  'dependencies',
  'baselines',
  'baseline_rows',
  'resources',
  'resource_time_off',
  'assignments',
  ...AUTOMATION_TABLES,
  ...ASSET_TABLES,
]

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
  ...AUTOMATION_SCHEMA,
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
    formula: { default: () => null },
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
  baselines: {
    id: { default: () => crypto.randomUUID(), notNull: true },
    sheet_id: { notNull: true },
    owner_id: { default: ({ uid }) => uid, notNull: true },
    workspace_id: { default: ({ uid }) => uid, notNull: true },
    slot: { notNull: true },
    name: { notNull: true },
    created_at: { default: ({ now }) => now(), notNull: true },
  },
  // No `id`: the primary key is (baseline_id, row_id).
  baseline_rows: {
    baseline_id: { notNull: true },
    sheet_id: { notNull: true },
    owner_id: { default: ({ uid }) => uid, notNull: true },
    workspace_id: { default: ({ uid }) => uid, notNull: true },
    row_id: { notNull: true },
    start_date: { notNull: true },
    end_date: { notNull: true },
    duration_days: { notNull: true },
  },
  resources: {
    id: { default: () => crypto.randomUUID(), notNull: true },
    owner_id: { default: ({ uid }) => uid, notNull: true },
    workspace_id: { default: ({ uid }) => uid, notNull: true },
    name: { notNull: true },
    kind: { default: () => 'person', notNull: true },
    department: { default: () => null },
    skills: { default: () => [], notNull: true },
    cost_rate: { default: () => 0, notNull: true },
    hours_by_weekday: { default: () => [0, 8, 8, 8, 8, 8, 0], notNull: true },
    created_at: { default: ({ now }) => now(), notNull: true },
  },
  resource_time_off: {
    id: { default: () => crypto.randomUUID(), notNull: true },
    resource_id: { notNull: true },
    owner_id: { default: ({ uid }) => uid, notNull: true },
    workspace_id: { default: ({ uid }) => uid, notNull: true },
    start_date: { notNull: true },
    end_date: { notNull: true },
    hours: { default: () => 0, notNull: true },
    note: { default: () => null },
    created_at: { default: ({ now }) => now(), notNull: true },
  },
  assignments: {
    id: { default: () => crypto.randomUUID(), notNull: true },
    sheet_id: { notNull: true },
    owner_id: { default: ({ uid }) => uid, notNull: true },
    workspace_id: { default: ({ uid }) => uid, notNull: true },
    row_id: { notNull: true },
    resource_id: { notNull: true },
    allocation_kind: { notNull: true },
    allocation_value: { notNull: true },
    start_date: { default: () => null },
    end_date: { default: () => null },
    created_at: { default: ({ now }) => now(), notNull: true },
  },
  ...ASSET_SCHEMA,
}

const COLUMN_TYPES = ['TEXT_NUMBER', 'DATE', 'CHECKBOX', 'PICKLIST', 'MULTI_PICKLIST', 'CONTACT_LIST', 'DURATION', 'PREDECESSOR']
const COLUMN_ROLES = ['start', 'end', 'duration', 'predecessor', 'percentComplete', 'status']
const DEP_TYPES = ['FS', 'SS', 'FF', 'SF']

export function emptyState(): FakeState {
  return {
    users: [],
    sessionUserId: null,
    tables: Object.fromEntries(TABLES.map((t) => [t, []])) as unknown as Record<TableName, DbRecord[]>,
    clock: 0,
  }
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
  /**
   * Act as the service role (the planning server): row-level security and the user-facing grants are
   * bypassed, `auth.admin.getUserById` works, and nothing defaults to the signed-in user.
   */
  serviceRole?: boolean
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
export function createFakeSupabase({ storage, key = FAKE_STORAGE_KEY, serviceRole = false }: FakeSupabaseOptions) {
  /** What `uid` is while acting as the service role: it owns nothing and defaults nothing. */
  const SERVICE_UID = ''
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

      /** A new anonymous user, signed in at once (as with anonymous sign-ins enabled in Supabase). */
      async signInAnonymously() {
        await tick()
        const state = read()
        const user = addUser(state, '', '')
        state.sessionUserId = user.id
        write(state)
        const session = sessionFor(user)
        emit('SIGNED_IN', session)
        return { data: { user: session.user, session }, error: null }
      },

      /** Service role only (the Auth admin API). */
      admin: {
        async getUserById(id: string) {
          await tick()
          if (!serviceRole) return { data: { user: null }, error: { message: 'User not allowed', status: 403 } }
          const u = read().users.find((x) => x.id === id)
          if (!u) return { data: { user: null }, error: { message: 'User not found', status: 404 } }
          return { data: { user: { id: u.id, email: u.email || undefined, is_anonymous: u.email === '' } }, error: null }
        },
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
    | { kind: 'upsert'; rows: DbRecord[]; onConflict: string[] }
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

    /**
     * INSERT ... ON CONFLICT (onConflict) DO UPDATE SET <the given columns>, like supabase-js's
     * upsert. `onConflict` defaults to the primary key `id`; it must name a unique key of the
     * table (`id`, or for dependencies `sheet_id,predecessor_row_id,successor_row_id`).
     */
    upsert(values: DbRecord | DbRecord[], options?: { onConflict?: string }): this {
      const extra = Object.keys(options ?? {}).filter((k) => k !== 'onConflict')
      if (extra.length > 0) unsupported(`${this.table}.upsert(..., {${extra.join(', ')}})`)
      const onConflict = (options?.onConflict ?? 'id').split(',').map((c) => c.trim())
      const key = onConflict.join(',')
      if (key !== 'id' && !(this.table === 'dependencies' && key === PAIR_KEY.join(','))) {
        unsupported(`${this.table}.upsert(..., { onConflict: ${JSON.stringify(key)} })`)
      }
      return this.setOp({ kind: 'upsert', rows: Array.isArray(values) ? values : [values], onConflict })
    }

    update(patch: DbRecord, options?: unknown): this {
      if (options !== undefined) unsupported(`${this.table}.update(..., options)`)
      if (this.table === 'baseline_rows') unsupported('baseline_rows.update() (baselines are read-only snapshots)')
      return this.setOp({ kind: 'update', patch })
    }

    delete(options?: unknown): this {
      if (options !== undefined) unsupported(`${this.table}.delete(options)`)
      return this.setOp({ kind: 'delete' })
    }

    private needFilterable(name: string): void {
      if (!this.op || this.op.kind === 'insert' || this.op.kind === 'upsert') unsupported(`${this.table}.${name}() on ${this.op?.kind ?? 'no operation'}`)
    }

    eq(col: string, value: unknown): this {
      this.needFilterable('eq')
      this.filters.push((r) => r[col] === value)
      return this
    }

    lte(col: string, value: unknown): this {
      this.needFilterable('lte')
      this.filters.push((r) => r[col] != null && compare(r[col], value) <= 0)
      return this
    }

    gte(col: string, value: unknown): this {
      this.needFilterable('gte')
      this.filters.push((r) => r[col] != null && compare(r[col], value) >= 0)
      return this
    }

    /** `is(col, null)`: the column is NULL. */
    is(col: string, value: null): this {
      this.needFilterable('is')
      if (value !== null) unsupported(`${this.table}.is(${col}, non-null)`)
      this.filters.push((r) => r[col] == null)
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
      const uid = serviceRole ? SERVICE_UID : (state.sessionUserId ?? '')
      if (!serviceRole && (!uid || !state.users.some((u) => u.id === uid))) {
        // The anon role has no grants on these tables.
        return { data: null, error: pgError(`permission denied for table ${this.table}`, '42501') }
      }
      const accessError = serviceRole ? null : automationAccessError(
        this.table,
        this.op.kind,
        this.op.kind === 'select' ? this.op.columns : undefined,
        this.op.kind === 'update' ? this.op.patch : undefined,
      )
      if (accessError) return { data: null, error: accessError }
      let result: FakeResult
      switch (this.op.kind) {
        case 'select':
          result = this.runSelect(state, uid, this.op.columns)
          break
        case 'insert':
          result = this.runInsert(state, uid, this.op.rows)
          break
        case 'upsert':
          result = this.runUpsert(state, uid, this.op.rows, this.op.onConflict)
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
      return state.tables[this.table].filter((r) => (serviceRole || r.owner_id === uid) && this.filters.every((f) => f(r)))
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
      if (!serviceRole && row.owner_id !== uid) return rlsError(this.table)
      if (isAssetTable(this.table)) return assetRowError(this.table, state, uid, row) // 0008_assets.sql
      if (this.table === 'resources' || this.table === 'resource_time_off') {
        const bad = resourceError(state, this.table, row)
        if (bad) return bad
      }
      if (this.table !== 'sheets' && this.table !== 'resources' && this.table !== 'resource_time_off' && !(row.sheet_id == null && this.table === 'notifications')) {
        const sheet = state.tables.sheets.find((s) => s.id === row.sheet_id)
        if (!sheet) return pgError(`insert or update on table "${this.table}" violates foreign key constraint`, '23503')
        if (!serviceRole && sheet.owner_id !== uid) return rlsError(this.table)
      }
      // 0002_hardening.sql: parents and dependency endpoints must be rows of the SAME sheet.
      const rowExists = (id: unknown) =>
        state.tables.rows.some((r) => r.id === id && r.sheet_id === row.sheet_id) ||
        (this.table === 'rows' && pending.some((r) => r.id === id && r.sheet_id === row.sheet_id))
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
      if (this.table === 'assignments') {
        const bad = assignmentError(state, uid, row)
        if (bad) return bad
      }
      if (this.table === 'baselines') {
        const bad = baselineFieldError(row.slot, row.name)
        if (bad) return bad
      }
      const autoError = automationRowError(this.table, row, state)
      if (autoError) return autoError
      if (this.table === 'baseline_rows') {
        // The rows belong to a baseline of the same sheet; row_id has no foreign key (it outlives its row).
        if (!state.tables.baselines.some((b) => b.id === row.baseline_id && b.sheet_id === row.sheet_id)) {
          return pgError('insert or update on table "baseline_rows" violates foreign key constraint', '23503')
        }
        const bad = baselineRowError(row)
        if (bad) return bad
      }
      return null
    }

    /** A new row with the schema's defaults filled in. */
    private withDefaults(state: FakeState, uid: string, v: DbRecord): DbRecord {
      const now = () => {
        state.clock = Math.max(Date.now(), state.clock + 1)
        return new Date(state.clock).toISOString()
      }
      const row: DbRecord = structuredClone(v)
      for (const [col, s] of Object.entries(SCHEMA[this.table])) {
        if (row[col] === undefined && s.default) row[col] = s.default({ uid, now })
      }
      computeGenerated(this.table, row)
      return row
    }

    /** Primary key and (dependencies) the one-per-pair unique key. Null when `row` is unique among `others`. */
    private uniqueError(row: DbRecord, others: DbRecord[]): FakeError | null {
      const autoDup = automationUniqueError(this.table, row, others)
      if (autoDup) return autoDup
      if (isAssetTable(this.table)) {
        const dup = assetUniqueError(this.table, row, others)
        if (dup) return dup
      }
      if (this.table === 'baseline_rows') {
        const dup = others.some((r) => r !== row && r.baseline_id === row.baseline_id && r.row_id === row.row_id)
        return dup ? pgError('duplicate key value violates unique constraint "baseline_rows_pkey"', '23505') : null
      }
      if (
        this.table === 'assignments' &&
        others.some((r) => r !== row && r.sheet_id === row.sheet_id && r.row_id === row.row_id && r.resource_id === row.resource_id)
      ) {
        return pgError('duplicate key value violates unique constraint "assignments_sheet_id_row_id_resource_id_key"', '23505')
      }
      if (this.table === 'baselines' && others.some((r) => r !== row && r.sheet_id === row.sheet_id && r.slot === row.slot)) {
        return pgError('duplicate key value violates unique constraint "baselines_sheet_id_slot_key"', '23505')
      }
      if (others.some((r) => r !== row && r.id === row.id)) {
        return pgError(`duplicate key value violates unique constraint "${this.table}_pkey"`, '23505')
      }
      if (this.table === 'dependencies' && others.some((r) => r !== row && samePair(r, row))) {
        return pgError('duplicate key value violates unique constraint "dependencies_pair_key"', '23505')
      }
      return null
    }

    private runInsert(state: FakeState, uid: string, values: DbRecord[]): FakeResult {
      const fresh = values.map((v) => this.withDefaults(state, uid, v))
      // The whole statement fails if any row fails (one statement, one transaction).
      const all = [...state.tables[this.table], ...fresh]
      for (const row of fresh) {
        const err = this.uniqueError(row, all) ?? this.checkRow(state, uid, row, fresh)
        if (err) return { data: null, error: err }
      }
      state.tables[this.table].push(...fresh)
      return { data: this.returned(fresh), error: null }
    }

    /** INSERT ... ON CONFLICT (onConflict) DO UPDATE SET <given columns>; all-or-nothing. */
    private runUpsert(state: FakeState, uid: string, values: DbRecord[], onConflict: string[]): FakeResult {
      const working = [...state.tables[this.table]]
      const written: DbRecord[] = []
      const fresh: DbRecord[] = []
      for (const v of values) {
        if (onConflict.some((c) => v[c] === undefined)) unsupported(`${this.table}.upsert() row without ${onConflict.join(',')}`)
        if (written.some((w) => onConflict.every((c) => w[c] === v[c]))) {
          return {
            data: null,
            error: pgError('ON CONFLICT DO UPDATE command cannot affect row a second time', '21000'),
          }
        }
        const i = working.findIndex((r) => onConflict.every((c) => r[c] === v[c]))
        let row: DbRecord
        if (i >= 0) {
          // The conflicting row must be visible to the caller for the UPDATE (RLS `using`).
          if (!serviceRole && working[i].owner_id !== uid) return { data: null, error: rlsError(this.table) }
          row = { ...working[i], ...structuredClone(v) }
          working[i] = row
        } else {
          row = this.withDefaults(state, uid, v)
          working.push(row)
          fresh.push(row)
        }
        written.push(row)
      }
      for (const row of written) {
        const err = this.uniqueError(row, working) ?? this.checkRow(state, uid, row, fresh)
        if (err) return { data: null, error: err }
      }
      state.tables[this.table] = working
      return { data: this.returned(written), error: null }
    }

    private runUpdate(state: FakeState, uid: string, patch: DbRecord): FakeResult {
      const targets = this.visible(state, uid).filter((r) => serviceRole || automationUpdatable(this.table, r, patch))
      const updated = targets.map((r) => ({ ...r, ...structuredClone(patch) }))
      if (isAssetTable(this.table)) {
        const now = () => {
          state.clock = Math.max(Date.now(), state.clock + 1)
          return new Date(state.clock).toISOString()
        }
        for (let i = 0; i < updated.length; i++) {
          const err = beforeAssetUpdate(this.table, targets[i], updated[i], now)
          if (err) return { data: null, error: err }
        }
      }
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
      if (this.table === 'baseline_rows' || this.table === 'row_locks') {
        // No id column: remove the matched records themselves.
        const gone = new Set(targets)
        state.tables[this.table] = state.tables[this.table].filter((r) => !gone.has(r))
      } else {
        removeWithCascade(state, this.table, new Set(targets.map((r) => r.id)))
      }
      return { data: this.returned(targets), error: null }
    }
  }

  /**
   * The database functions of 0003_columns.sql (SECURITY INVOKER, so limited to the caller's own
   * rows like everything else): `delete_column` and `set_column_cells`.
   */
  async function rpc(fn: string, args: Record<string, unknown> = {}): Promise<FakeResult<string | null>> {
    await tick()
    const state = read()
    const uid = serviceRole ? SERVICE_UID : (state.sessionUserId ?? '')
    if (!serviceRole && (!uid || !state.users.some((u) => u.id === uid))) {
      return { data: null, error: pgError(`permission denied for function ${fn}`, '42501') }
    }
    const ownRows = (sheetId: unknown) => state.tables.rows.filter((r) => (serviceRole || r.owner_id === uid) && r.sheet_id === sheetId)
    if (fn === 'delete_column') {
      const colId = args.p_column_id
      const col = state.tables.columns.find((c) => c.id === colId && c.owner_id === uid)
      if (!col) return { data: null, error: null } // already gone, or not the caller's: a no-op
      const key = String(colId)
      for (const r of ownRows(col.sheet_id)) {
        const cells = r.cells as Record<string, unknown>
        if (key in cells) delete cells[key]
      }
      state.tables.columns = state.tables.columns.filter((c) => c !== col)
    } else if (fn === 'set_column_cells') {
      const key = String(args.p_column_id)
      const values = (args.p_values ?? {}) as Record<string, unknown>
      const byId = new Map(ownRows(args.p_sheet_id).map((r) => [r.id, r]))
      for (const [rowId, value] of Object.entries(values)) {
        const cells = byId.get(rowId)?.cells as Record<string, unknown> | undefined
        if (!cells) continue
        if (value === null) delete cells[key]
        else cells[key] = structuredClone(value)
      }
    } else if (fn === 'copy_row_to_sheet') {
      const res = copyRowToSheet(state, serviceRole ? null : uid, args)
      if (res.error) return res
      write(state)
      return res
    } else if (fn === 'save_baseline') {
      const res = saveBaseline(state, uid, args)
      if (res.error) return res
      write(state)
      return res
    } else {
      unsupported(`rpc(${JSON.stringify(fn)})`)
    }
    write(state)
    return { data: null, error: null }
  }

  const client = { auth, from, rpc }
  return strict(client, 'client')
}

export type FakeSupabaseClient = ReturnType<typeof createFakeSupabase>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** The checks of `baselines` (slot 1-5, name 1-100 chars and not blank). Null when fine. */
function baselineFieldError(slot: unknown, name: unknown): FakeError | null {
  if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 1 || slot > 5) {
    return pgError('new row for relation "baselines" violates check constraint "baselines_slot_check"', '23514')
  }
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
    return pgError('new row for relation "baselines" violates check constraint "baselines_name_check"', '23514')
  }
  return null
}

/** The column types and checks of `baseline_rows` (dates, end >= start, duration >= 0). Null when fine. */
function baselineRowError(row: DbRecord): FakeError | null {
  if (typeof row.row_id !== 'string' || !UUID_RE.test(row.row_id)) {
    return pgError(`invalid input syntax for type uuid: "${String(row.row_id)}"`, '22P02')
  }
  for (const col of ['start_date', 'end_date'] as const) {
    const v = row[col]
    if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
      return pgError(`invalid input syntax for type date: "${String(v)}"`, '22007')
    }
  }
  if (typeof row.duration_days !== 'number' || !Number.isInteger(row.duration_days)) {
    return pgError(`invalid input syntax for type integer: "${String(row.duration_days)}"`, '22P02')
  }
  if (row.duration_days < 0 || String(row.end_date) < String(row.start_date)) {
    return pgError('new row for relation "baseline_rows" violates check constraint', '23514')
  }
  return null
}

/**
 * `save_baseline(p_sheet_id, p_slot, p_name, p_rows)` of 0006_baselines.sql: replaces the slot's
 * baseline and stores the rows, all or nothing, and returns the new baseline's id. `state` is only
 * changed when the whole call succeeds (the caller writes it back). The caller must own the sheet
 * (otherwise the baseline insert fails row-level security, as in the database).
 */
function saveBaseline(state: FakeState, uid: string, args: Record<string, unknown>): FakeResult<string | null> {
  const fail = (error: FakeError): FakeResult<string | null> => ({ data: null, error })
  const sheet = state.tables.sheets.find((s) => s.id === args.p_sheet_id && s.owner_id === uid)
  const slot = args.p_slot
  if (!sheet) return fail(rlsError('baselines'))
  const bad = baselineFieldError(slot, args.p_name)
  if (bad) return fail(bad)
  if (!Array.isArray(args.p_rows)) return fail(pgError('cannot extract elements from a non-array', '22023'))
  const baselineId = crypto.randomUUID()
  const rows: DbRecord[] = []
  const seen = new Set<string>()
  for (const raw of args.p_rows as Record<string, unknown>[]) {
    const row: DbRecord = {
      baseline_id: baselineId,
      sheet_id: sheet.id,
      owner_id: uid,
      workspace_id: uid,
      row_id: raw?.rowId ?? null,
      start_date: raw?.start ?? null,
      end_date: raw?.end ?? null,
      duration_days: raw?.durationDays ?? null,
    }
    if (row.row_id == null || row.start_date == null || row.end_date == null || row.duration_days == null) {
      return fail(pgError('null value in column of relation "baseline_rows" violates not-null constraint', '23502'))
    }
    const err = baselineRowError(row)
    if (err) return fail(err)
    const key = String(row.row_id).toLowerCase()
    if (seen.has(key)) return fail(pgError('duplicate key value violates unique constraint "baseline_rows_pkey"', '23505'))
    seen.add(key)
    rows.push(row)
  }
  state.clock = Math.max(Date.now(), state.clock + 1)
  const old = new Set(state.tables.baselines.filter((b) => b.sheet_id === sheet.id && b.slot === slot).map((b) => b.id))
  state.tables.baselines = state.tables.baselines.filter((b) => !old.has(b.id))
  state.tables.baseline_rows = state.tables.baseline_rows.filter((r) => !old.has(r.baseline_id))
  state.tables.baselines.push({
    id: baselineId,
    sheet_id: sheet.id,
    owner_id: uid,
    workspace_id: uid,
    slot,
    name: args.p_name,
    created_at: new Date(state.clock).toISOString(),
  })
  state.tables.baseline_rows.push(...rows)
  return { data: baselineId, error: null }
}

const RESOURCE_KINDS = ['person', 'role', 'equipment']
const ALLOCATION_MAX: Record<string, number> = { percent: 1000, hours_per_day: 24, hours_per_week: 168, total_hours: 100000 }

const checkFail = (table: string): FakeError => pgError(`new row for relation "${table}" violates check constraint`, '23514')

/** The checks of `resources` and `resource_time_off` (0010_resources.sql), plus time off's (resource, owner) key. */
function resourceError(state: FakeState, table: 'resources' | 'resource_time_off', row: DbRecord): FakeError | null {
  if (table === 'resources') {
    const name = row.name
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) return checkFail(table)
    if (!RESOURCE_KINDS.includes(String(row.kind))) return checkFail(table)
    const dep = row.department
    if (dep != null && (typeof dep !== 'string' || dep.trim().length === 0 || dep.length > 100)) return checkFail(table)
    const rate = row.cost_rate
    if (typeof rate !== 'number' || !(rate >= 0 && rate <= 1_000_000)) return checkFail(table)
    const skills = row.skills
    if (!Array.isArray(skills) || skills.length > 30 || skills.some((x) => typeof x !== 'string')) return checkFail(table)
    const h = row.hours_by_weekday
    if (!Array.isArray(h) || h.length !== 7 || h.some((x) => typeof x !== 'number' || !(x >= 0 && x <= 24))) return checkFail(table)
    return null
  }
  if (!state.tables.resources.some((r) => r.id === row.resource_id && r.owner_id === row.owner_id)) {
    return pgError('insert or update on table "resource_time_off" violates foreign key constraint', '23503')
  }
  for (const col of ['start_date', 'end_date'] as const) {
    const v = row[col]
    if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
      return pgError(`invalid input syntax for type date: "${String(v)}"`, '22007')
    }
  }
  const span = (Date.parse(String(row.end_date)) - Date.parse(String(row.start_date))) / 86_400_000
  if (!(span >= 0 && span <= 3660)) return checkFail(table)
  if (typeof row.hours !== 'number' || !(row.hours >= 0 && row.hours <= 24)) return checkFail(table)
  if (row.note != null && (typeof row.note !== 'string' || row.note.length > 200)) return checkFail(table)
  return null
}

/** The checks of `assignments` (0010_resources.sql): own resource, allocation ceilings, ordered dates. */
function assignmentError(state: FakeState, uid: string, row: DbRecord): FakeError | null {
  if (typeof row.row_id !== 'string' || !UUID_RE.test(row.row_id)) {
    return pgError(`invalid input syntax for type uuid: "${String(row.row_id)}"`, '22P02')
  }
  if (!state.tables.resources.some((r) => r.id === row.resource_id && r.owner_id === row.owner_id && r.owner_id === uid)) {
    return pgError('insert or update on table "assignments" violates foreign key constraint', '23503')
  }
  const max = ALLOCATION_MAX[String(row.allocation_kind)]
  const v = row.allocation_value
  if (max === undefined || typeof v !== 'number' || !(v > 0 && v <= max)) return checkFail('assignments')
  for (const col of ['start_date', 'end_date'] as const) {
    const d = row[col]
    if (d != null && (typeof d !== 'string' || !DATE_RE.test(d) || Number.isNaN(Date.parse(d)))) {
      return pgError(`invalid input syntax for type date: "${String(d)}"`, '22007')
    }
  }
  if (row.start_date != null && row.end_date != null && String(row.end_date) < String(row.start_date)) return checkFail('assignments')
  return null
}

/** The dependencies table's one-per-pair unique key (0002_hardening.sql). */
const PAIR_KEY = ['sheet_id', 'predecessor_row_id', 'successor_row_id'] as const

const samePair = (a: DbRecord, b: DbRecord) => PAIR_KEY.every((c) => a[c] === b[c])

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
  if (isAssetTable(table)) return cascadeAssets(state, table, ids)
  cascadeAutomation(state, table, ids)
  if (table === 'sheets') {
    cascadeAssets(state, 'sheets', ids) // placements and stars of the sheets
    state.tables.sheets = state.tables.sheets.filter((r) => !ids.has(r.id))
    state.tables.columns = state.tables.columns.filter((r) => !ids.has(r.sheet_id))
    state.tables.dependencies = state.tables.dependencies.filter((r) => !ids.has(r.sheet_id))
    state.tables.rows = state.tables.rows.filter((r) => !ids.has(r.sheet_id))
    state.tables.baselines = state.tables.baselines.filter((r) => !ids.has(r.sheet_id))
    state.tables.baseline_rows = state.tables.baseline_rows.filter((r) => !ids.has(r.sheet_id))
    // Unlike rows, a deleted sheet takes its assignments with it (on delete cascade).
    state.tables.assignments = state.tables.assignments.filter((r) => !ids.has(r.sheet_id))
    return
  }
  if (table === 'resources') {
    state.tables.resources = state.tables.resources.filter((r) => !ids.has(r.id))
    state.tables.resource_time_off = state.tables.resource_time_off.filter((r) => !ids.has(r.resource_id))
    state.tables.assignments = state.tables.assignments.filter((r) => !ids.has(r.resource_id))
    return
  }
  if (table === 'baselines') {
    state.tables.baselines = state.tables.baselines.filter((r) => !ids.has(r.id))
    state.tables.baseline_rows = state.tables.baseline_rows.filter((r) => !ids.has(r.baseline_id))
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
    cascadeAutomation(state, 'rows', all) // update / approval requests and locks of the deleted rows
    // baseline_rows.row_id and assignments.row_id deliberately have no foreign key: they survive a deleted row.
    state.tables.rows = state.tables.rows.filter((r) => !all.has(r.id))
    state.tables.dependencies = state.tables.dependencies.filter(
      (d) => !all.has(d.predecessor_row_id) && !all.has(d.successor_row_id),
    )
    return
  }
  state.tables[table] = state.tables[table].filter((r) => !ids.has(r.id))
}
