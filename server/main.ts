/**
 * Production entry point: wires the planning server from environment variables.
 *
 *   PORT                  port to listen on (Railway sets it; default 8787)
 *   ANTHROPIC_API_KEY     enables AI drafting; without it drafts come from history only
 *   ANTHROPIC_MODEL       optional, default claude-opus-5-5
 *   SUPABASE_URL          falls back to VITE_SUPABASE_URL
 *   SUPABASE_ANON_KEY     falls back to VITE_SUPABASE_ANON_KEY
 *   STATIC_DIR            optional, default ./dist
 *   PLANNER_DRAFTS_PER_HOUR       optional, per user, default 10
 *   PLANNER_MAX_CONCURRENT_DRAFTS optional, all users together, default 8
 */
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { DEFAULT_MODEL } from './ai'
import { createApp, DEFAULT_DRAFT_LIMITS } from './app'
import { consoleLogger as log } from './log'
import { createSupabaseAuthenticator } from './supabase'

const env = process.env
const port = Number(env.PORT) || 8787
const supabaseUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL
const supabaseAnonKey = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY
const apiKey = env.ANTHROPIC_API_KEY?.trim()
const model = env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL
const staticDir = path.resolve(env.STATIC_DIR || 'dist')

if (!supabaseUrl || !supabaseAnonKey) log('config.warning', { message: 'SUPABASE_URL / SUPABASE_ANON_KEY not set: the planner API answers 503.' })
if (!apiKey) log('config.warning', { message: 'ANTHROPIC_API_KEY not set: drafts are built from history only.' })

const server = createApp({
  staticDir,
  authenticate: supabaseUrl && supabaseAnonKey ? createSupabaseAuthenticator(supabaseUrl, supabaseAnonKey) : null,
  anthropic: apiKey ? new Anthropic({ apiKey }) : null,
  model,
  log,
  draftLimits: {
    ...DEFAULT_DRAFT_LIMITS,
    perUserPerHour: Number(env.PLANNER_DRAFTS_PER_HOUR) || DEFAULT_DRAFT_LIMITS.perUserPerHour,
    globalInFlight: Number(env.PLANNER_MAX_CONCURRENT_DRAFTS) || DEFAULT_DRAFT_LIMITS.globalInFlight,
  },
})

server.listen(port, () => log('server.listening', { port, staticDir, model, ai: Boolean(apiKey) }))

function shutdown(signal: string) {
  log('server.stopping', { signal })
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
