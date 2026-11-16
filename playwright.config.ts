import { defineConfig } from '@playwright/test'

const PORT = 5199

/**
 * End-to-end tests in a real browser against the app served in Vite mode `e2e`, where an
 * in-memory fake replaces the Supabase client (e2e/support/fakeSupabase.ts). Uses the machine's
 * installed Microsoft Edge; no Playwright browser download is needed.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    // Microsoft Edge by default; set PW_CHROMIUM_PATH to run on a plain Chromium binary instead.
    ...(process.env.PW_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
      : { channel: 'msedge' }),
    headless: true,
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev:e2e',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
