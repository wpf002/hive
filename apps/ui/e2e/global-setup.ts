import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { request } from '@playwright/test';
import { ADMIN, API_BASE, API_TOKEN, CUSTOMER, STATE_DIR, adminHeaders, stateFor } from './accounts';

/**
 * Create the two accounts the suite runs as, and sign each in exactly once.
 *
 * Signing in per test is the obvious thing and it is wrong here: the login
 * route is rate limited to ten attempts per five minutes, which is a correct
 * limit, and a suite that signs in fourteen times gets 429ed halfway through
 * and reports five failures that have nothing to do with the code. Loosening
 * the limit to suit the tests would be testing a system nobody runs. So the
 * session is established once per role and reused, and the specs that are
 * actually about signing in use the form directly.
 */
async function ensureUser(u: { email: string; displayName: string; role: 'admin' | 'user' }) {
  const pw = process.env.E2E_PASSWORD!;
  const create = await fetch(`${API_BASE}/api/admin/users`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ ...u, password: pw }),
  });
  if (create.status === 201) return;
  if (create.status !== 409) {
    throw new Error(`could not create ${u.email}: ${create.status} ${await create.text()}`);
  }
  // Left over from an interrupted run: adopt it rather than failing every
  // subsequent run on a 409.
  const list = await fetch(`${API_BASE}/api/admin/users`, { headers: adminHeaders() });
  const users = (await list.json()) as { id: string; email: string }[];
  const existing = users.find((x) => x.email === u.email);
  if (!existing) throw new Error(`${u.email} exists but was not listed`);
  const reset = await fetch(`${API_BASE}/api/admin/users/${existing.id}/reset-password`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ newPassword: pw }),
  });
  if (!reset.ok) throw new Error(`could not reset ${u.email}: ${reset.status}`);
}

/** Sign in through the API and keep the cookie jar for the specs to reuse. */
async function saveSession(email: string, baseURL: string) {
  const ctx = await request.newContext({ baseURL });
  const r = await ctx.post('/api/auth/login', {
    data: { email, password: process.env.E2E_PASSWORD! },
  });
  if (!r.ok()) throw new Error(`could not sign in ${email}: ${r.status()} ${await r.text()}`);
  await ctx.storageState({ path: stateFor(email) });
  await ctx.dispose();
}

export default async function globalSetup() {
  if (!API_TOKEN) {
    throw new Error('API_AUTH_TOKEN is unset — the suite needs an operator token to seed accounts');
  }
  // Minted here so every worker sees the same value: workers are forked after
  // global setup and inherit this environment.
  process.env.E2E_PASSWORD = `e2e-${randomBytes(12).toString('hex')}`;

  const health = await fetch(`${API_BASE}/healthz`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`API is not answering at ${API_BASE} — start it before running the E2E suite`);
  }

  await ensureUser(ADMIN);
  await ensureUser(CUSTOMER);

  await mkdir(STATE_DIR, { recursive: true });
  // Cookies are set on the UI origin, which proxies /api to the API.
  const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3002';
  await saveSession(ADMIN.email, baseURL);
  await saveSession(CUSTOMER.email, baseURL);
}
