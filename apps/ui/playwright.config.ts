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
});
