/**
 * Playwright configuration.
 *
 * The browser suite runs against a real `wrangler dev`, not a static render harness: the
 * routers are mounted in `apps/app/src/index.ts`, so the same Worker code that ships is the
 * code under test, including the security headers and the 404 handler.
 *
 * Viewports are set inside the tests that care about them rather than by multiplying the
 * whole suite across three projects — a viewport copy of a passing test is not a new case,
 * and the test ledger counts cases, not runs.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['E2E_PORT'] ?? 8788);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['junit', { outputFile: 'reports/playwright-junit.xml' }]] : [['list']],
  outputDir: 'reports/playwright',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // A tiny bit of tolerance: the Worker is cold on the first request.
    actionTimeout: 10_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npx wrangler dev --port ${PORT} --ip 127.0.0.1`,
    cwd: 'apps/app',
    url: BASE_URL,
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
