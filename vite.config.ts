/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.dirname(fileURLToPath(import.meta.url))

/**
 * Mode `e2e` only: every import of `src/lib/supabase.ts` (except the shim's own) resolves to
 * `e2e/support/supabaseShim.ts`, whose `createSupabaseClient` returns the in-memory fake. Other
 * modes never load this plugin, so the fake cannot reach the production bundle.
 */
function e2eFakeSupabase(): Plugin {
  const real = path.join(root, 'src', 'lib', 'supabase.ts')
  const shim = path.join(root, 'e2e', 'support', 'supabaseShim.ts')
  const same = (a: string, b: string) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase()
  return {
    name: 'e2e-fake-supabase',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || same(importer.split('?')[0], shim) || !/supabase/.test(source)) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (resolved && same(resolved.id.split('?')[0], real)) return shim
      return null
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'e2e' ? [e2eFakeSupabase()] : [])],
  // The planning server (`npm run dev:server`, port 8787; set PLANNER_SERVER_PORT if you move it).
  server: { proxy: { '/api': `http://localhost:${process.env.PLANNER_SERVER_PORT ?? 8787}` } },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    // The Playwright specs (e2e/*.spec.ts) run under `npx playwright test`, not Vitest; only the
    // fake backend's own unit tests run here.
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.ts', 'e2e/support/fakeSupabase.test.ts'],
    exclude: ['**/node_modules/**', 'e2e/*.spec.ts'],
  },
}))
