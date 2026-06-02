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

before(async () => {
  if (!dbUp) return;
  app = Fastify();
  await app.register(cookie);
  registerErrorHandler(app);
  await app.register(authRoutes);
  await app.register(botRoutes);
  await app.register(jobRoutes);
  await app.ready();

  await prisma.user.create({ data: { email: adminEmail, displayName: 'IT Admin', passwordHash: await hashPassword(PW), role: 'admin' } });
  await prisma.user.create({ data: { email: viewerEmail, displayName: 'IT Viewer', passwordHash: await hashPassword(PW), role: 'user' } });
  const t = await prisma.botTemplate.findFirst();
  templateId = t?.id ?? '';
});

after(async () => {
  if (!dbUp) return;
  if (createdBotId) await prisma.bot.deleteMany({ where: { id: createdBotId } });
  await prisma.bot.deleteMany({ where: { name: { startsWith: `itest-bot-${suffix}` } } });
  await prisma.user.deleteMany({ where: { email: { in: [adminEmail, viewerEmail] } } });
  await app.close();
  await prisma.$disconnect();
  try { await redis.quit(); } catch { /* already closed */ }
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
  assert.equal(res.statusCode, 200, `login should succeed for ${email}`);
  const c = res.cookies.find((x) => x.name === 'hive_session');
  assert.ok(c, 'login should set a session cookie');
  return `hive_session=${c!.value}`;
}

maybe('viewer (role:user) CAN list bots — read access is open', async () => {
  const cookie = await login(viewerEmail);
  const res = await app.inject({ method: 'GET', url: '/api/bots', headers: { cookie } });
  assert.equal(res.statusCode, 200);
});

maybe('viewer (role:user) CANNOT create a bot — 403', async () => {
  const cookie = await login(viewerEmail);
  const res = await app.inject({
    method: 'POST', url: '/api/bots', headers: { cookie },
    payload: { templateId, name: `itest-bot-${suffix}-viewer` },
  });
  assert.equal(res.statusCode, 403);
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

maybe('unauthenticated request is rejected — 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/bots' });
  assert.equal(res.statusCode, 401);
});
