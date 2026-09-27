import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for Matmon end-to-end specs.
 *
 * Why this config exists: vitest runs every component in isolation (370 specs,
 * all green) but never opens a real browser. The persistence layer of Matmon
 * straddles two drivers (Tauri plugin-sql + a localStorage shim) and the seams
 * between onboarding -> reload -> HomeView only failed when the live browser
 * actually round-tripped through localStorage. Playwright drives a real
 * Chromium against `vite` so we catch the bugs vitest is blind to.
 */
export default defineConfig({
  testDir: 'tests-e2e',
  fullyParallel: false, // one shared dev server, one storage state.
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1, // serialize so per-test localStorage cleanup is predictable.
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
