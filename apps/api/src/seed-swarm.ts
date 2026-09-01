/**
 * Swarm demo seed — builds one running mission with a full role cast and a
 * live blackboard, so the mission terminal has real motion to render before
 * the agent runtime is wired up.
 *
 *   pnpm --filter @hive/api seed              # base: templates + admin (first)
 *   pnpm --filter @hive/api seed:swarm        # this script
 *   pnpm --filter @hive/api seed:swarm -- --reset
 *
 * The board it writes is deliberately unflattering: three analysts agree on a
 * claim that only one source supports, next to a quieter claim that two
 * independent sources back. That's the case the whole dedup pass exists for,
 * and it should be visible on the comb the moment the terminal opens.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { prisma, Prisma } from '@hive/db';
import { Blackboard, type Challenge, type Finding, type Hypothesis } from '@hive/swarm';
import { env } from './env.js';
import { encryptBotConfig } from './lib/secrets.js';

const RESET = process.argv.includes('--reset');
const MISSION_NAME = 'Line movement watch (demo)';
/** Every bot this script creates is named with this prefix, so --reset can
 *  tell its own bots apart from any a user later bound to the same mission. */
const SEED_BOT_PREFIX = 'Demo · ';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const minsAgo = (n: number) => new Date(Date.now() - n * 60_000);

interface AgentSpec {
  templateName: string;
  botName: string;
  role: string;
  sourceId?: string;
  overrides?: Record<string, unknown>;
}

// Bound to templates the base seed actually creates. Verified against
// apps/api/src/seed.ts rather than assumed — a missing template here would
// silently produce a mission with no gatherers.
const AGENTS: AgentSpec[] = [
  {
    templateName: 'ESPN Scoreboard Scraper',
    botName: `${SEED_BOT_PREFIX}Gatherer · ESPN scoreboard`,
    role: 'gatherer',
    sourceId: 'espn',
  },
  {
    templateName: 'Sportsbook Line Scraper',
    botName: `${SEED_BOT_PREFIX}Gatherer · DraftKings lines`,
    role: 'gatherer',
    sourceId: 'draftkings',
    overrides: { book: 'draftkings' },
  },
  {
    templateName: 'Sportsbook Line Scraper',
    botName: `${SEED_BOT_PREFIX}Gatherer · FanDuel lines`,
    role: 'gatherer',
    sourceId: 'fanduel',
    overrides: { book: 'fanduel' },
  },
  { templateName: 'AI Single Call', botName: `${SEED_BOT_PREFIX}Extractor · line normaliser`, role: 'extractor' },
  { templateName: 'AI Single Call', botName: `${SEED_BOT_PREFIX}Analyst · movement`, role: 'analyst' },
  { templateName: 'AI Single Call', botName: `${SEED_BOT_PREFIX}Analyst · steam detector`, role: 'analyst' },
  { templateName: 'AI Multi-Provider Verdict', botName: `${SEED_BOT_PREFIX}Analyst · consensus`, role: 'analyst' },
  { templateName: 'AI Single Call', botName: `${SEED_BOT_PREFIX}Adversary · stale quote check`, role: 'adversary' },
  {
    templateName: 'Shell Command Runner (Native)',
    botName: `${SEED_BOT_PREFIX}Constraint · exposure gate`,
    role: 'constraint',
  },
  { templateName: 'HTTP Endpoint Monitor', botName: `${SEED_BOT_PREFIX}Executor · notify`, role: 'executor' },
];

async function main() {
  const admin = await prisma.user.findFirst({ where: { role: 'admin' } });
  if (!admin) {
    throw new Error('no admin user — run `pnpm --filter @hive/api seed` first');
  }

  const existing = await prisma.mission.findFirst({ where: { name: MISSION_NAME } });
  if (existing && !RESET) {
    console.log(`mission "${MISSION_NAME}" already seeded (${existing.id}) — pass --reset to rebuild`);
    return;
  }
  if (existing) {
    // Delete only bots this script created. Membership in the demo mission is
    // not proof of authorship — someone may have bound their own bot to it —
    // and --reset should never take a bot it didn't make.
    const priorBots = await prisma.missionAgent.findMany({
      where: { missionId: existing.id, bot: { name: { startsWith: SEED_BOT_PREFIX } } },
      select: { botId: true },
    });
    await prisma.mission.delete({ where: { id: existing.id } });
    const { count } = await prisma.bot.deleteMany({
      where: { id: { in: priorBots.map((b) => b.botId) } },
    });
    console.log(`reset: removed prior demo mission and ${count} seed-created bots`);
  }

  const mission = await prisma.mission.create({
    data: {
      userId: admin.id,
      name: MISSION_NAME,
      domain: 'trading',
      objective:
        'Flag games where the line moves against the money, confirmed by more than one book.',
      status: 'running',
      // Notify only. A demo mission that could place an order would be a
      // demo mission one config edit away from placing one.
      allowedActions: ['notify'],
      limits: { 'mission:actions': 20, min_independent_sources: 2, 'action:notify': 10 },
      approvalMode: 'manual',
    },
  });

  const botIdByRole = new Map<string, string[]>();
  for (const spec of AGENTS) {
    const template = await prisma.botTemplate.findFirst({ where: { name: spec.templateName } });
    if (!template) {
      console.warn(`  skip: template "${spec.templateName}" not found`);
      continue;
    }
    const config = {
      ...((template.defaultConfig ?? {}) as Record<string, unknown>),
      ...(spec.overrides ?? {}),
    };
    const bot = await prisma.bot.create({
      data: {
        templateId: template.id,
        userId: admin.id,
        name: spec.botName,
        config: (await encryptBotConfig(template, config)) as Prisma.InputJsonValue,
        enabled: true,
      },
    });
    await prisma.missionAgent.create({
      data: {
        missionId: mission.id,
        botId: bot.id,
        role: spec.role,
        sourceId: spec.sourceId ?? null,
        subscribes: spec.role === 'gatherer' ? [] : ['finding'],
        lastSeenAt: new Date(),
      },
    });
    botIdByRole.set(spec.role, [...(botIdByRole.get(spec.role) ?? []), bot.id]);

    // Recent completed work is what the terminal reads as "this bee is
    // foraging". Leaving jobs in `running` with no worker to finish them would
    // (correctly) render the whole mission as stalled a few minutes later.
    await prisma.job.create({
      data: {
        botId: bot.id,
        status: 'succeeded',
        payload: {},
        startedAt: minsAgo(1),
        finishedAt: new Date(),
        result: { seeded: true },
      },
    });
  }

  const gatherers = botIdByRole.get('gatherer') ?? [];
  const analysts = botIdByRole.get('analyst') ?? [];
  const adversaries = botIdByRole.get('adversary') ?? [];

  // ---- the board ----------------------------------------------------------

  const redis = new Redis(env.REDIS_URL, { lazyConnect: false });
  const board = new Blackboard(redis, mission.id);

  const mkFinding = (sourceId: string, agentId: string, body: string, n: number): Finding => ({
    id: randomUUID(),
    missionId: mission.id,
    agentId,
    kind: 'line',
    payload: { note: body },
    provenance: {
      sourceId,
      subject: '',
      sourceKind: 'http',
      observedAt: minsAgo(30 - n).toISOString(),
      fetchedAt: minsAgo(29 - n).toISOString(),
      contentHash: sha(`${sourceId}:${body}`),
      jobId: `seed-${n}`,
    },
  });

  const findings: Finding[] = [
    mkFinding('espn', gatherers[0] ?? 'espn-agent', 'LAL -3.5 open', 1),
    mkFinding('espn', gatherers[0] ?? 'espn-agent', 'LAL -2.5 current', 2),
    // Same bytes from the same source, seen twice. Collapses to one signal —
    // this pair is the point of the demo.
    mkFinding('espn', gatherers[0] ?? 'espn-agent', 'LAL -2.5 current', 3),
    mkFinding('draftkings', gatherers[1] ?? 'dk-agent', 'LAL -2.5, 62% tickets on LAL', 4),
    mkFinding('fanduel', gatherers[2] ?? 'fd-agent', 'LAL -2.5, 58% tickets on LAL', 5),
  ];
  for (const f of findings) await board.post({ type: 'finding', data: f });

  // Persist alongside the stream. The DB's @@unique([missionId, sourceId,
  // contentHash]) is the durable half of the dedup rule, so the duplicate in
  // `findings` is expected to bounce here — that rejection is the demo.
  const persisted = await prisma.finding.createMany({
    data: findings.map((f) => ({
      id: f.id,
      missionId: mission.id,
      agentId: f.agentId,
      kind: f.kind,
      payload: f.payload as Prisma.InputJsonValue,
      sourceId: f.provenance.sourceId,
      sourceKind: f.provenance.sourceKind,
      observedAt: new Date(f.provenance.observedAt),
      fetchedAt: new Date(f.provenance.fetchedAt),
      contentHash: f.provenance.contentHash,
      jobId: f.provenance.jobId,
    })),
    skipDuplicates: true,
  });

  // Three analysts, one claim, one source behind it — the echo case.
  const echoed: Hypothesis[] = analysts.map((agentId) => ({
    id: randomUUID(),
    missionId: mission.id,
    agentId,
    claim: 'Line is moving toward the favorite',
    confidence: 0.82,
    supportingFindingIds: [findings[0].id, findings[1].id],
    independentSources: 0,
  }));

  // One claim, two independent books behind it — the corroborated case.
  const corroborated: Hypothesis = {
    id: randomUUID(),
    missionId: mission.id,
    agentId: analysts[0] ?? 'analyst',
    claim: 'Money is on the favorite across both books',
    confidence: 0.71,
    supportingFindingIds: [findings[3].id, findings[4].id],
    independentSources: 0,
  };

  const refuted: Hypothesis = {
    id: randomUUID(),
    missionId: mission.id,
    agentId: analysts[1] ?? 'analyst',
    claim: 'Sharp reverse line movement detected',
    confidence: 0.64,
    supportingFindingIds: [findings[1].id],
    independentSources: 0,
  };

  for (const h of [...echoed, corroborated, refuted]) {
    await board.post({ type: 'hypothesis', data: h });
  }
  await prisma.hypothesis.createMany({
    data: [...echoed, corroborated, refuted].map((h) => ({
      id: h.id,
      missionId: mission.id,
      agentId: h.agentId,
      claim: h.claim,
      confidence: h.confidence,
      supportingFindingIds: h.supportingFindingIds,
    })),
  });

  const challenge: Challenge = {
    id: randomUUID(),
    hypothesisId: refuted.id,
    agentId: adversaries[0] ?? 'adversary',
    objection: 'The quote backing this is 40 minutes stale; the move already reverted.',
    severity: 'refutes',
  };
  await board.post({ type: 'challenge', data: challenge });
  await prisma.challenge.create({
    data: {
      id: challenge.id,
      hypothesisId: challenge.hypothesisId,
      agentId: challenge.agentId,
      objection: challenge.objection,
      severity: challenge.severity,
    },
  });

  await redis.quit();

  console.log(`seeded mission ${mission.id}`);
  console.log(`  agents:   ${AGENTS.length}`);
  console.log(
    `  findings: ${findings.length} posted, ${persisted.count} persisted ` +
      '(the duplicate was rejected by the unique constraint)',
  );
  console.log(`  claims:   ${echoed.length} echoing one source, 1 corroborated, 1 refuted`);
  console.log(`  open:     /missions/${mission.id}`);
  console.log(
    '  note:     this is a static snapshot — agents read as idle ~10 minutes',
  );
  console.log('            after seeding. Re-run to refresh the swarm.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
