import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against a running Hive.
 *
 * These exist because the UI had no tests at all across sixty-one files, and
 * the things most worth protecting are not units — they are whole paths a
 * customer walks: can they sign in, do they land on the product rather than
 * the machinery, can they reach their own settings, can they sign out.
 *
 * The suite drives a real browser against a real API and a real database. A
 * mocked version of these flows would have passed happily while the admin gate
 * was wrong, because the gate lives in a server component that only exists
 * when something actually renders it.
 */
// localhost, not 127.0.0.1. The page's origin has to match what the API's
// CORS allowlist is configured with (HIVE_PUBLIC_APP_URL), and pinning the
// browser to 127.0.0.1 makes every request in the suite cross-origin — which
// CORS then correctly refuses, and which surfaces as "Failed to fetch" on a
// login form that looks broken.
//
// The IPv6 half of this is handled where it belongs: the test:e2e script sets
// --dns-result-order=ipv4first, so Node's own calls do not resolve localhost
// to ::1 while the dev servers are bound to IPv4.
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3002';

export default defineConfig({
  testDir: './e2e',
  // Serial by default: the suite signs accounts in and out, and parallel
  // workers sharing those accounts would revoke each other's sessions.
  workers: 1,
  fullyParallel: false,
  // Never in CI. A retry that turns red into green hides a flake, and a flake
  // in an auth flow is a real defect wearing a costume.
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  /**
   * Playwright owns the servers.
   *
   * Relying on hand-started dev servers made the suite fail for reasons that
   * had nothing to do with the application — a server that had stopped between
   * runs shows up as ERR_CONNECTION_REFUSED in whichever spec happened to run
   * first, which reads like a broken page. `reuseExistingServer` means a
   * running stack is used as-is; otherwise it is started and torn down with
   * the run.
   *
   * Ordered API first: the UI proxies /api to it, and a UI that comes up
   * against a missing API serves a login page that cannot log anybody in.
   */
  webServer: [
    {
      command: 'pnpm --filter @hive/api dev',
      url: 'http://localhost:4010/healthz',
      cwd: '../..',
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @hive/ui dev',
      url: 'http://localhost:3002/login',
      cwd: '../..',
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
