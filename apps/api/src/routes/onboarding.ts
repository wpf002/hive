/**
 * Onboarding: vertical selection → creates a pre-configured starter bot pack
 * for the user, plus a daily schedule for each bot.
 *
 * Vertical packs use existing templates — the value is the pre-filled config
 * and the "batteries included" scheduling so the user sees results on day 1.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import cronParser from 'cron-parser';
import { prisma, Prisma } from '@hive/db';
import { requireAuth } from '../auth.js';
import { encryptBotConfig } from '../lib/secrets.js';
import { assertPublicUrl, SsrfError } from '../lib/ssrf.js';

const VERTICALS = ['ecommerce', 'recruiting', 'agency', 'trading'] as const;
type Vertical = (typeof VERTICALS)[number];

const Body = z.object({
  vertical: z.enum(VERTICALS),
  // Context the user provides to personalise their starter pack.
  siteUrl: z.string().url().optional(),        // agency / ecommerce: their site or client site
  keyword: z.string().max(100).optional(),      // recruiting / trading: role or ticker
  email: z.string().email().optional(),         // where to send alerts
  slackWebhookUrl: z.string().url().optional(), // optional Slack alert channel
});

type StarterBot = {
  templateName: string;
  botName: string;
  config: Record<string, unknown>;
};

/** Returns the starter bot specs for a given vertical + context. */
function starterPack(vertical: Vertical, ctx: z.infer<typeof Body>): StarterBot[] {
  const url = ctx.siteUrl ?? 'https://example.com';
  const keyword = ctx.keyword ?? 'AI engineering jobs';

  switch (vertical) {
    case 'ecommerce':
      return [
        {
          templateName: 'HTTP Health Check',
          botName: 'Store Health Check',
          config: { url, expectedStatus: 200, method: 'GET', timeoutSeconds: 10 },
        },
        {
          templateName: 'SSL Certificate Checker',
          botName: 'Store SSL Monitor',
          config: { hostname: new URL(url).hostname, port: 443, warningDaysThreshold: 30 },
        },
        {
          templateName: 'Web Page Screenshot',
          botName: 'Competitor Daily Screenshot',
          config: { url, fullPage: false, waitMs: 2000 },
        },
      ];

    case 'recruiting':
      return [
        {
          templateName: 'HTTP Health Check',
          botName: 'Job Board Health Check',
          config: { url: ctx.siteUrl ?? 'https://jobs.ashbyhq.com', expectedStatus: 200, method: 'GET', timeoutSeconds: 10 },
        },
        {
          templateName: 'Web Page Screenshot',
          botName: 'Careers Page Snapshot',
          config: { url: ctx.siteUrl ?? 'https://example.com/careers', fullPage: false, waitMs: 2000 },
        },
        {
          templateName: 'Perplexity Search',
          botName: 'Job Market Trends',
          config: { query: `Latest hiring trends and compensation data for ${keyword} roles`, maxTokens: 800 },
        },
      ];

    case 'agency':
      return [
        {
          templateName: 'HTTP Health Check',
          botName: 'Client Site Monitor',
          config: { url, expectedStatus: 200, method: 'GET', timeoutSeconds: 10 },
        },
        {
          templateName: 'SSL Certificate Checker',
          botName: 'Client SSL Monitor',
          config: { hostname: new URL(url).hostname, port: 443, warningDaysThreshold: 30 },
        },
        {
          templateName: 'Web Page Screenshot',
          botName: 'Client Homepage Snapshot',
          config: { url, fullPage: false, waitMs: 2000 },
        },
      ];

    case 'trading':
      return [
        {
          templateName: 'Trading Portfolio Snapshot',
          botName: 'Daily Portfolio Snapshot',
          config: { exchange: 'kraken', currencies: ['BTC', 'ETH', 'USD'] },
        },
        {
          templateName: 'Arbitrage Watcher',
          botName: 'BTC Spread Monitor',
          config: { exchanges: ['kraken', 'coinbase'], symbol: 'BTC/USD', alertThresholdPct: 0.5 },
        },
        {
          templateName: 'Perplexity Search',
          botName: 'Crypto Market Brief',
          config: { query: `${keyword} price analysis and market news today`, maxTokens: 800 },
        },
      ];
  }
}

function nextRunFor(cron: string): Date {
  return cronParser.parseExpression(cron, { currentDate: new Date() }).next().toDate();
}

// Stagger daily schedules slightly so bots don't all slam the workers at once.
// Offset is per-bot-index in minutes past 11:30 UTC (7:30 AM ET).
function dailyCron(offsetMinutes: number): string {
  return `${30 + offsetMinutes} 11 * * *`;
}

export async function onboardingRoutes(app: FastifyInstance) {
  // GET /api/onboarding — returns current profile (if any).
  app.get('/api/onboarding', { preHandler: requireAuth('api') }, async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) return reply.code(401).send({ error: { code: 'no_session' } });
    const profile = await prisma.userProfile.findUnique({ where: { userId } });
    return profile ?? { userId, onboarded: false, vertical: null };
  });

  // POST /api/onboarding — selects a vertical and creates the starter pack.
  app.post('/api/onboarding', { preHandler: requireAuth('api') }, async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) return reply.code(401).send({ error: { code: 'no_session' } });
    const isAdmin = req.staticAuth === 'api' || req.user?.role === 'admin';

    const body = Body.parse(req.body);

    // Same SSRF guard as POST /api/alerts — this field becomes an Alert row
    // below, so leaving it unchecked here would just be the other door.
    if (body.slackWebhookUrl) {
      try {
        await assertPublicUrl(body.slackWebhookUrl);
      } catch (e) {
        if (e instanceof SsrfError) {
          return reply.code(400).send({ error: { code: 'blocked_url', message: e.message } });
        }
        throw e;
      }
    }

    // Idempotent: if already onboarded, return current profile without recreating bots.
    const existing = await prisma.userProfile.findUnique({ where: { userId } });
    if (existing?.onboarded) {
      return reply.send({ alreadyOnboarded: true, profile: existing });
    }

    // Resolve template ids by name.
    const templates = await prisma.botTemplate.findMany();
    const templateByName = new Map(templates.map((t) => [t.name, t]));

    const pack = starterPack(body.vertical, body);
    const created: Array<{ botId: string; botName: string; scheduleId: string }> = [];

    for (let i = 0; i < pack.length; i++) {
      const spec = pack[i];
      const template = templateByName.get(spec.templateName);
      if (!template) {
        app.log.warn({ templateName: spec.templateName }, 'onboarding_template_not_found');
        continue;
      }
      const encryptedConfig = await encryptBotConfig(template, spec.config);
      const bot = await prisma.bot.create({
        data: {
          templateId: template.id,
          userId,
          name: spec.botName,
          config: encryptedConfig as Prisma.InputJsonValue,
          enabled: true,
        },
      });
      const cron = dailyCron(i * 2); // stagger by 2 min per bot
      // Onboarding writes Schedule rows directly, so it would sail past the
      // admin gate on POST /api/schedules. A starter pack shouldn't be a second
      // door to the thing that door locks: for a non-admin the schedules are
      // created disabled, and an admin turns the pack on.
      const startEnabled = isAdmin;
      const schedule = await prisma.schedule.create({
        data: {
          botId: bot.id,
          cron,
          enabled: startEnabled,
          nextRunAt: startEnabled ? nextRunFor(cron) : null,
        },
      });
      created.push({ botId: bot.id, botName: spec.botName, scheduleId: schedule.id });
    }

    // Create alert rules if the user provided contact info.
    if (body.email || body.slackWebhookUrl) {
      await prisma.alert.createMany({
        data: [
          ...(body.email ? [{
            userId,
            channel: 'email',
            config: { email: body.email } as Prisma.InputJsonValue,
            triggerOn: 'failed,recovered',
            enabled: true,
          }] : []),
          ...(body.slackWebhookUrl ? [{
            userId,
            channel: 'slack',
            config: { webhookUrl: body.slackWebhookUrl } as Prisma.InputJsonValue,
            triggerOn: 'failed,recovered',
            enabled: true,
          }] : []),
        ],
      });
    }

    // Mark onboarding complete.
    const profile = await prisma.userProfile.upsert({
      where: { userId },
      create: { userId, vertical: body.vertical, onboarded: true },
      update: { vertical: body.vertical, onboarded: true },
    });

    return reply.code(201).send({
      profile,
      botsCreated: created,
      // Non-admin packs are created dormant; say so rather than letting the
      // user believe their bots are already running.
      schedulesEnabled: isAdmin,
      ...(isAdmin
        ? {}
        : {
            note: 'Your starter bots were created, but their schedules are off until an admin enables them.',
          }),
    });
  });
}
