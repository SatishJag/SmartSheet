// Test helper (node only): a PGlite (Postgres in WASM) database that looks enough like Supabase
// for our migrations to run unchanged. NOTE: verified against PGlite, not a real Supabase instance.
// Real Supabase provides the `auth` schema, `auth.uid()` and the `anon` / `authenticated` roles;
// the setup below recreates just those, including Supabase's default privileges (which grant
// ALL on new public tables and functions to anon and authenticated).
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

export const MIGRATIONS_DIR = resolve(__dirname, '../../supabase/migrations')

/** Every migration file, in the order `supabase db reset` applies them. */
export function allMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
}

export async function createSupabaseLikeDb(migrations: string[] = allMigrations()): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(`
    create schema auth;
    create role authenticated nologin;
    create role anon nologin;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public to authenticated, anon;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
  `)
  for (const file of migrations) {
    await db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8'))
  }
  return db
}

/** Role switches mirroring what PostgREST does per request. */
export function roles(db: PGlite) {
  return {
    async asAnon() {
      await db.exec('RESET ROLE')
      await db.query(`select set_config('request.jwt.claim.sub', '', false)`)
      await db.exec('SET ROLE anon')
    },
    async asUser(uid: string | null) {
      await db.exec('RESET ROLE')
      await db.exec('SET ROLE authenticated')
      await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? ''])
    },
    /** The SQL editor / service role: bypasses RLS. */
    async asSuperuser() {
      await db.exec('RESET ROLE')
      await db.query(`select set_config('request.jwt.claim.sub', '', false)`)
    },
  }
}
