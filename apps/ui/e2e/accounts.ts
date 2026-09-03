import path from 'node:path';
/**
 * The two accounts every spec needs, and how to reach the API as an operator.
 *
 * Both are created by global setup and deleted by global teardown, so the suite
 * leaves the database exactly as it found it. That matters locally, where these
 * run against the same Postgres a person is using, and where a pile of
 * abandoned e2e-* users would be somebody's problem later.
 */
export const API_BASE = process.env.E2E_API_BASE ?? 'http://localhost:4010';

/** Static operator token — the same one the scheduler and dispatcher use. */
export const API_TOKEN = process.env.API_AUTH_TOKEN ?? '';

export const ADMIN = {
  email: 'e2e-admin@hive.test',
  displayName: 'E2E Admin',
  role: 'admin' as const,
};

export const CUSTOMER = {
  email: 'e2e-customer@hive.test',
  displayName: 'E2E Customer',
  role: 'user' as const,
};

/**
 * Generated per run rather than hardcoded. A fixed password in a repository is
 * a fixed password in every checkout of it, and these accounts are real rows in
 * a real database that may not always be a throwaway one.
 *
 * Global setup mints it and puts it in the environment; workers are forked
 * afterwards and inherit it. Reading it through a function rather than a
 * module-level constant matters: this module is imported by global setup too,
 * and a constant would be captured before the value exists.
 */
export function password(): string {
  const pw = process.env.E2E_PASSWORD;
  if (!pw) throw new Error('E2E_PASSWORD is unset — global setup did not run');
  return pw;
}

export function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' };
}

/** Where saved sessions live. Gitignored — these are real session cookies.
 *  Resolved from __dirname rather than import.meta: Playwright loads these
 *  files as CommonJS, where import.meta does not exist. */
export const STATE_DIR = path.join(__dirname, '.auth');

export function stateFor(email: string): string {
  return `${STATE_DIR}/${email.replace(/[^a-z0-9]/gi, '-')}.json`;
}
