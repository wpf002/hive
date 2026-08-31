/**
 * Integration test — locks in the admin-only authorization boundary on the
 * execution surface (bot create / run). Regression guard for the "restrict job
 * execution to admins" change.
 *
 * Requires a reachable Postgres + Redis (real .env). Run via:
 *   pnpm --filter @hive/api test:integration
 * Auto-skips (does not fail) when the DB can't be reached, so it's safe in
 * environments without infra.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { prisma } from '@hive/db';
import { redis } from '../redis.js';
import { registerErrorHandler } from '../errors.js';
import { authRoutes } from './auth.js';
import { botRoutes } from './bots.js';
import { jobRoutes } from './jobs.js';
import { scheduleRoutes } from './schedules.js';
import { hashPassword } from '../lib/passwords.js';

let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}
const maybe = (name: string, fn: () => Promise<void>) => test(name, { skip: dbUp ? false : 'no database reachable' }, fn);

let app: FastifyInstance;
const suffix = Math.random().toString(36).slice(2, 10);
const adminEmail = `it-admin-${suffix}@test.local`;
const viewerEmail = `it-viewer-${suffix}@test.local`;
const PW = 'integration-test-pw-123';
let templateId = '';
let createdBotId = '';
let viewerBotId = '';

before(async () => {
  if (!dbUp) return;
  app = Fastify();
  await app.register(cookie);
  registerErrorHandler(app);
  await app.register(authRoutes);
  await app.register(botRoutes);
  await app.register(jobRoutes);
  await app.register(scheduleRoutes);
  await app.ready();

  await prisma.user.create({ data: { email: adminEmail, displayName: 'IT Admin', passwordHash: await hashPassword(PW), role: 'admin' } });
  await prisma.user.create({ data: { email: viewerEmail, displayName: 'IT Viewer', passwordHash: await hashPassword(PW), role: 'user' } });
  const t = await prisma.botTemplate.findFirst();
  templateId = t?.id ?? '';

  // Login is Redis-rate-limited by source IP, and the counter outlives the
  // process. Without this, a second run of the suite in the same window starts
  // at the limit and every test fails on 429 rather than on what it asserts.
  const rlKeys = await redis.keys('hive:ratelimit:*');
  if (rlKeys.length > 0) await redis.del(...rlKeys);
});

after(async () => {
  if (!dbUp) return;
  if (createdBotId) await prisma.bot.deleteMany({ where: { id: createdBotId } });
  if (viewerBotId) await prisma.bot.deleteMany({ where: { id: viewerBotId } });
  await prisma.bot.deleteMany({ where: { name: { startsWith: `itest-bot-${suffix}` } } });
  await prisma.user.deleteMany({ where: { email: { in: [adminEmail, viewerEmail] } } });
  await app.close();
  await prisma.$disconnect();
  try { await redis.quit(); } catch { /* already closed */ }
});

// Login is rate-limited on purpose (see lib/rate-limit.ts), so the suite logs
// in once per identity and reuses the cookie rather than burning the budget and
// failing on 429 as it grows.
const sessions = new Map<string, string>();

async function login(email: string): Promise<string> {
  const cached = sessions.get(email);
  if (cached) return cached;
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
  assert.equal(res.statusCode, 200, `login should succeed for ${email}`);
  const c = res.cookies.find((x) => x.name === 'hive_session');
  assert.ok(c, 'login should set a session cookie');
  const cookie = `hive_session=${c!.value}`;
  sessions.set(email, cookie);
  return cookie;
}

maybe('viewer (role:user) CAN list bots — read access is open', async () => {
  const cookie = await login(viewerEmail);
  const res = await app.inject({ method: 'GET', url: '/api/bots', headers: { cookie } });
  assert.equal(res.statusCode, 200);
});

// A bot is inert: it is a stored config, and nothing runs until something
// triggers it. Multi-tenancy (a41a1f5) deliberately lets a user own bots, so
// creation is open and scoped to the owner. The boundary that matters is the
// trigger — /run and /api/schedules — which the tests below pin down.
maybe('viewer (role:user) CAN create a bot, scoped to them — 201', async () => {
  if (!templateId) return;
  const cookie = await login(viewerEmail);
  const res = await app.inject({
    method: 'POST', url: '/api/bots', headers: { cookie },
    payload: { templateId, name: `itest-bot-${suffix}-viewer` },
  });
  assert.equal(res.statusCode, 201, res.body);
  viewerBotId = JSON.parse(res.body).id;

  // Ownership, not a shared/admin bot (userId null would make it visible to
  // every admin and orphan it from its creator).
  const row = await prisma.bot.findUnique({ where: { id: viewerBotId } });
  const viewer = await prisma.user.findUnique({ where: { email: viewerEmail } });
  assert.equal(row?.userId, viewer?.id);
});

maybe('admin CAN create a bot — 201', async () => {
  if (!templateId) return; // no templates seeded; nothing to create against
  const cookie = await login(adminEmail);
  const res = await app.inject({
    method: 'POST', url: '/api/bots', headers: { cookie },
    payload: { templateId, name: `itest-bot-${suffix}-admin` },
  });
  assert.equal(res.statusCode, 201, res.body);
  createdBotId = JSON.parse(res.body).id;
  assert.ok(createdBotId);
});

maybe('viewer (role:user) CANNOT run a bot — 403 (no dispatch)', async () => {
  if (!createdBotId) return;
  const cookie = await login(viewerEmail);
  const res = await app.inject({ method: 'POST', url: `/api/bots/${createdBotId}/run`, headers: { cookie }, payload: {} });
  assert.equal(res.statusCode, 403);
});

// --- the execution boundary -------------------------------------------------
//
// These exist because the gap between them was a full privilege escalation: a
// non-admin could not press "run", but could install a cron that pressed it,
// and the scheduler triggers runs with API_AUTH_TOKEN, which counts as admin.

maybe('viewer (role:user) CANNOT schedule their own bot — 403', async () => {
  if (!viewerBotId) return;
  const cookie = await login(viewerEmail);
  const res = await app.inject({
    method: 'POST', url: '/api/schedules', headers: { cookie },
    payload: { botId: viewerBotId, cron: '* * * * *' },
  });
  assert.equal(
    res.statusCode, 403,
    'a schedule is a standing instruction to execute code — it must be admin-only',
  );
});

maybe('viewer CANNOT re-enable a schedule an admin disabled — 403', async () => {
  if (!viewerBotId) return;
  const adminCookie = await login(adminEmail);
  const created = await app.inject({
    method: 'POST', url: '/api/schedules', headers: { cookie: adminCookie },
    payload: { botId: viewerBotId, cron: '0 3 * * *', enabled: false },
  });
  assert.equal(created.statusCode, 201, created.body);
  const scheduleId = JSON.parse(created.body).id;

  const cookie = await login(viewerEmail);
  const res = await app.inject({
    method: 'PATCH', url: `/api/schedules/${scheduleId}`, headers: { cookie },
    payload: { enabled: true },
  });
  assert.equal(res.statusCode, 403);
});

maybe('editing a bot config revokes its schedules', async () => {
  if (!viewerBotId) return;
  const adminCookie = await login(adminEmail);
  const created = await app.inject({
    method: 'POST', url: '/api/schedules', headers: { cookie: adminCookie },
    payload: { botId: viewerBotId, cron: '0 4 * * *' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const scheduleId = JSON.parse(created.body).id;
  assert.equal(JSON.parse(created.body).enabled, true);

  // The owner swaps the config out from under the admin's authorization.
  const cookie = await login(viewerEmail);
  const patched = await app.inject({
    method: 'PATCH', url: `/api/bots/${viewerBotId}`, headers: { cookie },
    payload: { config: { command: 'echo swapped' } },
  });
  assert.equal(patched.statusCode, 200, patched.body);

  const after = await prisma.schedule.findUnique({ where: { id: scheduleId } });
  assert.equal(
    after?.enabled, false,
    'an admin approved the config that existed when they scheduled it, not whatever replaces it',
  );
  assert.equal(after?.nextRunAt, null);
});

maybe('unauthenticated request is rejected — 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/bots' });
  assert.equal(res.statusCode, 401);
});
