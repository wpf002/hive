/**
 * Demo seed — fills every UI page with realistic sample data on top of the
 * base seed (templates + admin). Idempotent: writes a `demo.seeded` AuditLog
 * sentinel and exits early on re-run so it never piles up duplicates.
 *
 *   pnpm --filter @hive/api seed        # base: templates + admin (run first)
 *   pnpm --filter @hive/api seed:demo   # this script
 *
 * Re-seed from scratch with:  pnpm --filter @hive/api seed:demo -- --reset
 */
import { prisma, Prisma } from '@hive/db';
import { hashPassword } from './lib/passwords.js';
import { encryptBotConfig } from './lib/secrets.js';
import { initStorage, saveArtifact } from './lib/artifacts.js';

const RESET = process.argv.includes('--reset');
const mins = (n: number) => new Date(Date.now() - n * 60_000);
const fromNow = (n: number) => new Date(Date.now() + n * 60_000);

// A tiny valid 1x1 PNG so artifact download actually returns something.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function tmpl(name: string) {
  const t = await prisma.botTemplate.findFirst({ where: { name } });
  if (!t) throw new Error(`template not found: "${name}" — run \`pnpm --filter @hive/api seed\` first`);
  return t;
}

async function makeBot(opts: {
  templateName: string;
  name: string;
  overrides?: Record<string, unknown>;
  enabled?: boolean;
}) {
  const template = await tmpl(opts.templateName);
  const base = (template.defaultConfig ?? {}) as Record<string, unknown>;
  const config = { ...base, ...(opts.overrides ?? {}) };
  const encrypted = await encryptBotConfig(template, config);
  const bot = await prisma.bot.create({
    data: {
      templateId: template.id,
      name: opts.name,
      config: encrypted as Prisma.InputJsonValue,
      enabled: opts.enabled ?? true,
    },
    include: { template: true },
  });
  return bot;
}

type LogLine = { level: 'debug' | 'info' | 'warn' | 'error'; message: string; meta?: Prisma.InputJsonValue };
type JobSpec = {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  ageMin: number;
  durationMin?: number;
  result?: Prisma.InputJsonValue;
  error?: string;
  logs?: LogLine[];
};

async function makeJob(bot: { id: string; config: unknown; template: { name: string; poolType: string } }, spec: JobSpec) {
  const createdAt = mins(spec.ageMin);
  const startedAt = spec.status === 'queued' ? null : createdAt;
  const finishedAt =
    spec.status === 'succeeded' || spec.status === 'failed' || spec.status === 'cancelled'
      ? new Date(createdAt.getTime() + (spec.durationMin ?? 1) * 60_000)
      : null;
  const job = await prisma.job.create({
    data: {
      botId: bot.id,
      status: spec.status,
      priority: 0,
      attempts: spec.status === 'failed' ? 3 : 1,
      maxAttempts: 3,
      payload: {
        config: bot.config as Prisma.InputJsonValue,
        templateName: bot.template.name,
        pool: bot.template.poolType,
      } as Prisma.InputJsonValue,
      result: spec.result ?? Prisma.JsonNull,
      error: spec.error ?? null,
      startedAt,
      finishedAt,
      createdAt,
    },
  });
  const logs = spec.logs ?? defaultLogs(spec, bot.template.poolType);
  let ts = startedAt ? startedAt.getTime() : createdAt.getTime();
  for (const l of logs) {
    ts += 1500;
    await prisma.jobLog.create({
      data: { jobId: job.id, level: l.level, message: l.message, meta: l.meta ?? Prisma.JsonNull, timestamp: new Date(ts) },
    });
  }
  return job;
}

function defaultLogs(spec: JobSpec, pool: string): LogLine[] {
  const base: LogLine[] = [
    { level: 'info', message: `worker.claimed pool=${pool}` },
    { level: 'debug', message: 'config.loaded' },
    { level: 'info', message: 'work.started' },
  ];
  if (spec.status === 'succeeded') base.push({ level: 'info', message: 'work.completed ok=true' });
  if (spec.status === 'failed') base.push({ level: 'error', message: spec.error ?? 'work.failed' });
  if (spec.status === 'cancelled') base.push({ level: 'warn', message: 'job.cancelled by operator' });
  if (spec.status === 'running') base.push({ level: 'info', message: 'work.in_progress 60%' });
  return base;
}

async function main() {
  await initStorage();

  const already = await prisma.auditLog.findFirst({ where: { action: 'demo.seeded' } });
  if (already && !RESET) {
    console.log('✓ demo data already present (pass `-- --reset` to wipe and re-seed). Nothing to do.');
    return;
  }
  if (RESET) {
    console.log('… --reset: clearing prior demo data');
    // Order matters for FKs; cascades handle logs/artifacts via Job/Bot deletes.
    await prisma.paperTrade.deleteMany({});
    await prisma.tradeAudit.deleteMany({});
    await prisma.paperWallet.deleteMany({});
    await prisma.aiUsage.deleteMany({});
    await prisma.artifact.deleteMany({});
    await prisma.schedule.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.bot.deleteMany({});
    await prisma.worker.deleteMany({});
    await prisma.auditLog.deleteMany({ where: { action: { in: ['demo.seeded', 'system.incident'] } } });
  }

  // ---------- A second (non-admin) user so /admin/users has variety ----------
  const viewerHash = await hashPassword('viewer-demo-1234');
  const viewer = await prisma.user.upsert({
    where: { email: 'viewer@hive.dev' },
    update: { displayName: 'Vera Viewer', passwordHash: viewerHash, role: 'user' },
    create: { email: 'viewer@hive.dev', displayName: 'Vera Viewer', passwordHash: viewerHash, role: 'user', lastLoginAt: mins(90) },
  });
  const operatorHash = await hashPassword('operator-demo-1234');
  const operator = await prisma.user.upsert({
    where: { email: 'operator@hive.dev' },
    update: { displayName: 'Otto Operator', passwordHash: operatorHash, role: 'admin' },
    create: { email: 'operator@hive.dev', displayName: 'Otto Operator', passwordHash: operatorHash, role: 'admin', lastLoginAt: mins(15) },
  });
  const admin = await prisma.user.findFirst({ where: { role: 'admin' }, orderBy: { createdAt: 'asc' } });
  console.log(`✓ users: admin(${admin?.email}) + ${operator.email} + ${viewer.email}`);

  // ---------- Bots across pools ----------
  const nfl = await makeBot({ templateName: 'ESPN Scoreboard Scraper', name: 'NFL Scoreboard', overrides: { league: 'nfl', dateOffset: 0 } });
  const odds = await makeBot({ templateName: 'Sportsbook Line Scraper', name: 'DK NFL Lines', overrides: { book: 'draftkings', league: 'nfl' } });
  const brief = await makeBot({ templateName: 'AI Single Call', name: 'Daily Claude Brief', overrides: { provider: 'claude', userPrompt: 'Give me a 3-line ops brief.', maxTokens: 300 } });
  const verdict = await makeBot({ templateName: 'AI Multi-Provider Verdict', name: 'Model Showdown' });
  const monitor = await makeBot({ templateName: 'HTTP Endpoint Monitor', name: 'Homepage Monitor', overrides: { url: 'https://example.com' } });
  const heartbeat = await makeBot({ templateName: 'Cron Heartbeat', name: 'Alive Heartbeat' });
  const discord = await makeBot({ templateName: 'Discord Channel Poster', name: 'Ops Channel Poster', overrides: { botToken: 'demo-discord-bot-token-abc123', channelId: '987654321', content: 'Deploy finished ✅' } });
  const trade = await makeBot({ templateName: 'Trading Market Order', name: 'BTC Paper Buy', overrides: { exchange: 'binance', symbol: 'BTC/USDT', side: 'buy', amount: 0.01, mode: 'paper', apiKey: 'demo-key', apiSecret: 'demo-secret' } });
  const screenshot = await makeBot({ templateName: 'Full Page Screenshot', name: 'Landing Page Shot' });
  const shell = await makeBot({ templateName: 'Shell Command Runner (Native)', name: 'Nightly Echo', enabled: false });
  console.log('✓ created 11 bots across pools');

  // ---------- Jobs in every status (+ logs) ----------
  await makeJob(nfl, { status: 'succeeded', ageMin: 120, durationMin: 1, result: { games: 14, league: 'nfl' } });
  await makeJob(nfl, { status: 'failed', ageMin: 60, durationMin: 1, error: 'ESPN API returned 503' });
  await makeJob(odds, { status: 'succeeded', ageMin: 95, result: { events: 16, markets: 3 } });
  await makeJob(odds, { status: 'queued', ageMin: 2 });

  const briefJob1 = await makeJob(brief, {
    status: 'succeeded', ageMin: 40, result: { provider: 'claude', text: 'All systems nominal. No incidents. Costs on track.' },
    logs: [
      { level: 'info', message: 'ai.request provider=claude model=claude-sonnet' },
      { level: 'debug', message: 'ai.tokens in=212 out=88' },
      { level: 'info', message: 'ai.completed ok=true' },
    ],
  });
  await makeJob(brief, { status: 'running', ageMin: 1 });
  const verdictJob = await makeJob(verdict, {
    status: 'succeeded', ageMin: 30, durationMin: 2, result: { verdict: 'consensus', agree: 2, total: 3 },
    logs: [
      { level: 'info', message: 'ai.fanout providers=claude,gpt,perplexity' },
      { level: 'info', message: 'ai.provider claude done' },
      { level: 'info', message: 'ai.provider gpt done' },
      { level: 'warn', message: 'ai.provider perplexity slow (4.2s)' },
      { level: 'info', message: 'verdict.synthesized mode=consensus' },
    ],
  });

  await makeJob(monitor, { status: 'succeeded', ageMin: 25, result: { ok: true, statusCode: 200, latencyMs: 187 } });
  await makeJob(monitor, { status: 'succeeded', ageMin: 15, result: { ok: true, statusCode: 200, latencyMs: 203 } });
  await makeJob(monitor, { status: 'failed', ageMin: 10, error: 'expected 200, got 502 (bad gateway)' });
  await makeJob(heartbeat, { status: 'succeeded', ageMin: 5, result: { label: 'hive', host: 'demo-worker-1' } });
  await makeJob(heartbeat, { status: 'queued', ageMin: 1 });
  await makeJob(discord, { status: 'succeeded', ageMin: 50, result: { messageId: '111222333' } });
  await makeJob(discord, { status: 'cancelled', ageMin: 45 });

  // Trading job → drives PaperTrade + TradeAudit below.
  const tradeJob = await makeJob(trade, {
    status: 'succeeded', ageMin: 35, durationMin: 1,
    result: { mode: 'paper', filled: true, executedPrice: 67250.5, amount: 0.01 },
    logs: [
      { level: 'info', message: 'trade.quote BTC/USDT=67250.50' },
      { level: 'info', message: 'trade.paper_fill amount=0.01 side=buy' },
      { level: 'info', message: 'wallet.debited USDT=672.51' },
    ],
  });

  // Screenshot job → real artifacts on disk.
  const shotJob = await makeJob(screenshot, {
    status: 'succeeded', ageMin: 20, durationMin: 1, result: { width: 1280, height: 3200, format: 'png' },
    logs: [
      { level: 'info', message: 'browser.launch headless=true' },
      { level: 'info', message: 'page.goto https://example.com' },
      { level: 'info', message: 'artifact.saved screenshot.png' },
    ],
  });
  await saveArtifact(shotJob.id, 'screenshot.png', PNG_1x1, 'image/png');
  await saveArtifact(shotJob.id, 'page.html', Buffer.from('<!doctype html><title>Example</title><h1>Example Domain</h1>'), 'text/html');
  await saveArtifact(shotJob.id, 'console.log', Buffer.from('[info] navigation complete\n[info] 0 console errors\n'), 'text/plain');
  console.log('✓ created jobs across all statuses + logs + 3 artifacts');

  // ---------- AI usage (today) ----------
  await prisma.aiUsage.createMany({
    data: [
      { jobId: briefJob1.id, provider: 'claude', model: 'claude-sonnet-4', inputTokens: 212, outputTokens: 88, costCents: 4, createdAt: mins(40) },
      { jobId: verdictJob.id, provider: 'claude', model: 'claude-sonnet-4', inputTokens: 320, outputTokens: 140, costCents: 7, createdAt: mins(30) },
      { jobId: verdictJob.id, provider: 'gpt', model: 'gpt-4o', inputTokens: 318, outputTokens: 132, costCents: 6, createdAt: mins(30) },
      { jobId: verdictJob.id, provider: 'perplexity', model: 'sonar', inputTokens: 300, outputTokens: 110, costCents: 2, createdAt: mins(30) },
      { provider: 'gpt', model: 'gpt-4o-mini', inputTokens: 1200, outputTokens: 640, costCents: 3, createdAt: mins(180) },
    ],
  });
  console.log('✓ AI usage rows for today');

  // ---------- Schedules ----------
  await prisma.schedule.create({ data: { botId: nfl.id, cron: '0 * * * *', enabled: true, lastRunAt: mins(60), nextRunAt: fromNow(30) } });
  await prisma.schedule.create({ data: { botId: monitor.id, cron: '*/5 * * * *', enabled: true, lastRunAt: mins(5), nextRunAt: fromNow(2) } });
  await prisma.schedule.create({ data: { botId: heartbeat.id, cron: '*/1 * * * *', enabled: false, lastRunAt: mins(120), nextRunAt: null } });
  console.log('✓ 3 schedules (2 enabled, 1 disabled)');

  // ---------- Workers across pools (mixed health) ----------
  const W = (id: string, pool: string, host: string, status: string, ageSec: number, extra: Partial<Prisma.WorkerCreateManyInput> = {}) => ({
    id, poolType: pool, hostname: host, status,
    region: extra.region ?? 'local', zone: extra.zone ?? 'default',
    capacity: extra.capacity ?? 4, activeJobs: extra.activeJobs ?? 0,
    lastSeenAt: new Date(Date.now() - ageSec * 1000),
    metadata: (extra.metadata ?? { version: '0.1.0', status }) as Prisma.InputJsonValue,
  });
  await prisma.worker.createMany({
    data: [
      W('wk-ai-1', 'ai_agent', 'ai-worker-1', 'online', 3, { activeJobs: 1, region: 'us-east', zone: 'a' }),
      W('wk-ai-2', 'ai_agent', 'ai-worker-2', 'online', 8, { activeJobs: 0, region: 'us-east', zone: 'b' }),
      W('wk-scr-1', 'scraper', 'scraper-1', 'online', 5, { activeJobs: 2 }),
      W('wk-scr-2', 'scraper', 'scraper-2', 'draining', 12, { activeJobs: 1, metadata: { version: '0.1.0', status: 'draining' } }),
      W('wk-mon-1', 'monitor', 'monitor-1', 'online', 4),
      W('wk-brw-1', 'browser', 'browser-1', 'online', 9, { activeJobs: 1 }),
      W('wk-dsc-1', 'discord', 'discord-1', 'online', 7),
      W('wk-tsk-1', 'task_runner', 'task-runner-1', 'online', 6),
      W('wk-ci-1', 'ci_agent', 'ci-agent-1', 'draining', 20, { metadata: { version: '0.1.0', status: 'draining' } }),
      W('wk-trd-1', 'trading', 'trading-1', 'offline', 600, { region: 'us-west', zone: 'a' }),
    ],
  });
  console.log('✓ 11 workers (online / draining / offline)');

  // ---------- Trading data ----------
  const wallets: Array<[string, string, string]> = [
    ['binance', 'USDT', '9327.49'],
    ['binance', 'BTC', '0.51000000'],
    ['coinbase', 'USD', '5000.00'],
    ['kraken', 'USDT', '2500.00'],
  ];
  for (const [exchange, currency, balance] of wallets) {
    await prisma.paperWallet.upsert({
      where: { exchange_currency: { exchange, currency } },
      update: { balance: new Prisma.Decimal(balance) },
      create: { exchange, currency, balance: new Prisma.Decimal(balance) },
    });
  }
  await prisma.paperTrade.create({
    data: {
      jobId: tradeJob.id, exchange: 'binance', symbol: 'BTC/USDT', side: 'buy', type: 'market',
      amount: new Prisma.Decimal('0.01000000'), price: new Prisma.Decimal('67250.50'),
      status: 'filled', executedPrice: new Prisma.Decimal('67250.50'), createdAt: mins(35),
    },
  });
  await prisma.tradeAudit.createMany({
    data: [
      { jobId: tradeJob.id, botId: trade.id, mode: 'paper', action: 'market_order', payload: { symbol: 'BTC/USDT', side: 'buy', amount: 0.01 }, result: { filled: true, executedPrice: 67250.5 }, createdAt: mins(35) },
      { jobId: tradeJob.id, botId: trade.id, mode: 'paper', action: 'wallet_debit', payload: { currency: 'USDT', amount: 672.51 }, result: { balance: 9327.49 }, createdAt: mins(35) },
    ],
  });
  console.log('✓ paper wallets, 1 paper trade, 2 trade-audit rows');

  // ---------- Audit log + a status-page incident ----------
  const auditUser = admin?.id ?? operator.id;
  await prisma.auditLog.createMany({
    data: [
      { userId: auditUser, action: 'auth.login', ipAddress: '127.0.0.1', createdAt: mins(15) },
      { userId: auditUser, action: 'admin.user_created', targetType: 'user', targetId: viewer.id, payload: { email: viewer.email, role: 'user' }, createdAt: mins(89) },
      { userId: auditUser, action: 'paper_wallet.seed', targetType: 'paper_wallet', payload: { exchange: 'binance', currency: 'USDT', amount: 10000 }, createdAt: mins(200) },
      { action: 'auth.login_failed', payload: { email: 'mallory@evil.test' }, ipAddress: '203.0.113.9', createdAt: mins(33) },
      { userId: viewer.id, action: 'auth.login', ipAddress: '127.0.0.1', createdAt: mins(90) },
      { action: 'system.incident', targetId: 'scraper-degraded', payload: { message: 'Scraper pool degraded for ~4m (auto-recovered)' }, createdAt: mins(150) },
    ],
  });

  // Sentinel so re-runs are no-ops.
  await prisma.auditLog.create({ data: { action: 'demo.seeded', payload: { at: new Date().toISOString() } } });
  console.log('✓ audit log + 1 incident');
  console.log('\n✅ Demo seed complete. Log in as admin to see Run/edit controls; viewer@hive.dev is read-only.');
}

main()
  .catch((err) => {
    console.error('demo_seed_failed', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
