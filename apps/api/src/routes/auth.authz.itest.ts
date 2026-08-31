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
import { artifactRoutes } from './artifacts.js';
import { tradingRoutes } from './trading.js';
import { alertRoutes } from './alerts.js';
import { workerRoutes } from './workers.js';
import { initStorage } from '../lib/artifacts.js';
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
let adminJobId = '';
let secretBotId = '';
let secretField = '';

before(async () => {
  if (!dbUp) return;
  // The presign route needs a storage provider; index.ts does this at boot.
  await initStorage();
  app = Fastify();
  await app.register(cookie);
  registerErrorHandler(app);
  await app.register(authRoutes);
  await app.register(botRoutes);
  await app.register(jobRoutes);
  await app.register(scheduleRoutes);
  await app.register(artifactRoutes);
  await app.register(tradingRoutes);
  await app.register(alertRoutes);
  await app.register(workerRoutes);
  await app.ready();

  await prisma.user.create({ data: { email: adminEmail, displayName: 'IT Admin', passwordHash: await hashPassword(PW), role: 'admin' } });
  await prisma.user.create({ data: { email: viewerEmail, displayName: 'IT Viewer', passwordHash: await hashPassword(PW), role: 'user' } });
  const t = await prisma.botTemplate.findFirst();
  templateId = t?.id ?? '';

  // An admin-owned bot with a job, so the cross-tenant tests below have
  // something a viewer must not be able to reach.
  if (templateId) {
    const adminBot = await prisma.bot.create({
      data: { templateId, userId: null, name: `itest-bot-${suffix}-adminowned`, config: {} },
    });
    const job = await prisma.job.create({
      data: { botId: adminBot.id, status: 'running', payload: {} },
    });
    adminJobId = job.id;
  }

  // A template carrying an x-secret field, to prove an override secret never
  // lands in Job.payload in cleartext.
  const withSecret = (await prisma.botTemplate.findMany()).find((t) => {
    const props = (t.configSchema as { properties?: Record<string, { 'x-secret'?: boolean }> })
      .properties;
    return props && Object.values(props).some((v) => v?.['x-secret'] === true);
  });
  if (withSecret) {
    const props = (withSecret.configSchema as {
      properties: Record<string, { 'x-secret'?: boolean }>;
    }).properties;
    secretField = Object.keys(props).find((k) => props[k]?.['x-secret'] === true) ?? '';
    const b = await prisma.bot.create({
      data: {
        templateId: withSecret.id,
        userId: null,
        name: `itest-bot-${suffix}-secret`,
        config: {},
      },
    });
    secretBotId = b.id;
  }

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
  if (adminJobId) await prisma.job.deleteMany({ where: { id: adminJobId } });
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

// --- cross-tenant isolation -------------------------------------------------
//
// Everything below descends from a Bot's userId. These routes each forgot that,
// and returned every tenant's data to any logged-in caller.

maybe('viewer cannot see another user\'s job in the list', async () => {
  if (!adminJobId) return;
  const cookie = await login(viewerEmail);
  const res = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  const ids = (JSON.parse(res.body) as { id: string }[]).map((j) => j.id);
  assert.ok(!ids.includes(adminJobId), 'admin-owned job leaked into a viewer\'s job list');
});

maybe('viewer gets 404, not 403, fetching another user\'s job', async () => {
  if (!adminJobId) return;
  const cookie = await login(viewerEmail);
  const res = await app.inject({ method: 'GET', url: `/api/jobs/${adminJobId}`, headers: { cookie } });
  // 404 rather than 403 so the endpoint isn't an existence oracle for job ids.
  assert.equal(res.statusCode, 404);
});

maybe('a run never persists a cleartext override secret into Job.payload', async () => {
  if (!secretBotId || !secretField) return;
  const cookie = await login(adminEmail);
  const run = await app.inject({
    method: 'POST', url: `/api/bots/${secretBotId}/run`, headers: { cookie },
    payload: { overrideConfig: { [secretField]: 'sk-live-SUPERSECRET-0001' } },
  });
  // A pool may reject the run for unrelated reasons; only assert on success.
  if (run.statusCode !== 201) return;
  const jobId = JSON.parse(run.body).id;
  const row = await prisma.job.findUnique({ where: { id: jobId } });
  const raw = JSON.stringify(row?.payload ?? {});
  assert.ok(
    !raw.includes('SUPERSECRET'),
    'an override secret was written to Job.payload in cleartext',
  );

  const viaHttp = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } });
  assert.ok(!viaHttp.body.includes('SUPERSECRET'), 'job endpoint served a cleartext secret');
});

maybe('viewer cannot stream another user\'s job logs', async () => {
  if (!adminJobId) return;
  const cookie = await login(viewerEmail);
  const res = await app.inject({
    method: 'GET', url: `/api/jobs/${adminJobId}/stream`, headers: { cookie },
  });
  assert.equal(res.statusCode, 404, 'the SSE log stream must be scoped like every other job read');
});

maybe('viewer cannot list another user\'s artifacts', async () => {
  if (!adminJobId) return;
  const cookie = await login(viewerEmail);
  const res = await app.inject({
    method: 'GET', url: `/api/jobs/${adminJobId}/artifacts`, headers: { cookie },
  });
  assert.equal(res.statusCode, 404);
});

maybe('viewer cannot download or presign another user\'s artifact', async () => {
  if (!adminJobId) return;
  const art = await prisma.artifact.create({
    data: {
      jobId: adminJobId,
      filename: 'secret.png',
      contentType: 'image/png',
      sizeBytes: 1,
      storageKey: `${adminJobId}/secret.png`,
    },
  });
  const cookie = await login(viewerEmail);
  const dl = await app.inject({ method: 'GET', url: `/api/artifacts/${art.id}`, headers: { cookie } });
  assert.equal(dl.statusCode, 404);
  // The presign route must refuse too — the token it mints is a bearer
  // capability that carries no further authorization.
  const ps = await app.inject({
    method: 'GET', url: `/api/artifacts/${art.id}/presigned`, headers: { cookie },
  });
  assert.equal(ps.statusCode, 404);

  const adminCookie = await login(adminEmail);
  const own = await app.inject({
    method: 'GET', url: `/api/artifacts/${art.id}/presigned`, headers: { cookie: adminCookie },
  });
  assert.equal(own.statusCode, 200, 'the owner must still be able to presign');
  await prisma.artifact.delete({ where: { id: art.id } });
});

maybe('viewer cannot read another user\'s live trade audit', async () => {
  if (!adminJobId) return;
  const adminBot = await prisma.job.findUnique({ where: { id: adminJobId }, select: { botId: true } });
  const row = await prisma.tradeAudit.create({
    data: {
      jobId: adminJobId,
      botId: adminBot!.botId,
      mode: 'live',
      action: 'placeOrder',
      payload: {},
      result: {},
    },
  });
  const cookie = await login(viewerEmail);
  const res = await app.inject({ method: 'GET', url: '/api/trade-audit', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  const ids = (JSON.parse(res.body) as { id: string }[]).map((r) => r.id);
  assert.ok(!ids.includes(row.id), 'live order flow leaked across tenants');

  // Naming the victim's bot explicitly must NARROW the scope, not replace it.
  // Spreading the ownership filter alongside the query params put both on the
  // same `botId` key, so ?botId= silently deleted the restriction.
  const targeted = await app.inject({
    method: 'GET',
    url: `/api/trade-audit?botId=${adminBot!.botId}&mode=live`,
    headers: { cookie },
  });
  assert.equal(targeted.statusCode, 200);
  assert.deepEqual(
    JSON.parse(targeted.body),
    [],
    'a query param must not be able to widen the ownership scope back out',
  );

  // The owner still sees it, so the scope narrows rather than blanket-denies.
  const adminCookie = await login(adminEmail);
  const asAdmin = await app.inject({
    method: 'GET',
    url: `/api/trade-audit?botId=${adminBot!.botId}&mode=live`,
    headers: { cookie: adminCookie },
  });
  assert.ok(
    (JSON.parse(asAdmin.body) as { id: string }[]).some((r) => r.id === row.id),
    'the owner must still be able to filter to their own bot',
  );

  await prisma.tradeAudit.delete({ where: { id: row.id } });
});

maybe('an alert webhook pointing at the cloud metadata endpoint is refused', async () => {
  const cookie = await login(viewerEmail);
  const res = await app.inject({
    method: 'POST', url: '/api/alerts', headers: { cookie },
    payload: {
      channel: 'slack',
      config: { webhookUrl: 'http://169.254.169.254/latest/meta-data/' },
    },
  });
  assert.equal(res.statusCode, 400, 'the scheduler would have made this request from inside the network');
  assert.match(JSON.parse(res.body).error.code, /blocked_url/);
});

maybe('GET /api/workers does not mutate worker rows', async () => {
  const w = await prisma.worker.create({
    data: {
      poolType: 'task_runner',
      hostname: `itest-${suffix}`,
      status: 'online',
      lastSeenAt: new Date(Date.now() - 10 * 60_000), // long stale
    },
  });
  const cookie = await login(viewerEmail);
  const res = await app.inject({ method: 'GET', url: '/api/workers', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  // The response reports it offline...
  const shown = (JSON.parse(res.body) as { id: string; status: string }[]).find((x) => x.id === w.id);
  assert.equal(shown?.status, 'offline');
  // ...but a GET must not have written that back.
  const after = await prisma.worker.findUnique({ where: { id: w.id } });
  assert.equal(after?.status, 'online', 'a read verb wrote to the database');
  await prisma.worker.delete({ where: { id: w.id } });
});

maybe('unauthenticated request is rejected — 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/bots' });
  assert.equal(res.statusCode, 401);
});
