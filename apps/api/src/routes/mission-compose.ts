import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import cronParser from 'cron-parser';
import { prisma, Prisma } from '@hive/db';
import { requireRole } from '../auth.js';
import { env } from '../env.js';
import { encryptBotConfig } from '../lib/secrets.js';
import { coerceConfigToSchema } from '../lib/schema-coerce.js';
import { writeAuditLog } from '../lib/audit.js';

/**
 * Plain English in, a running swarm out.
 *
 * This is the whole product surface: you describe what you want watched, and
 * this composes the mission — which feeds to pull from, one gatherer per feed,
 * how often, and what the swarm is actually trying to decide.
 *
 * Only gatherers get bots. The analyst, adversary, coordinator and executor run
 * inside apps/coordinator and are attributed by role, so there is nothing to
 * create for them — binding placeholder bots would just be furniture that
 * implies a scheduled job which never runs.
 *
 * Admin-only, because it starts a mission and writes Schedule rows, both of
 * which are admin-gated everywhere else. A non-admin composing a running swarm
 * through a side door would reopen the escalation those gates closed.
 */

const Body = z.object({
  description: z.string().min(8).max(2000),
});

const COMPOSE_TOOL: Anthropic.Tool = {
  name: 'compose_mission',
  description: 'Compose one mission from the request, using only templates in the catalog.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'domain', 'objective', 'gatherers'],
    properties: {
      name: { type: 'string', description: 'Short, human. e.g. "NBA line movement".' },
      domain: { type: 'string', description: 'One word: trading, racing, monitoring, recruiting, research…' },
      objective: {
        type: 'string',
        description:
          'What the swarm must decide, in one sentence. This is handed to the coordinator verbatim, so make it a decision, not a topic.',
      },
      gatherers: {
        type: 'array',
        description:
          'One per distinct upstream source. 2 to 5. Two gatherers must never share a sourceId — corroboration across sources is the only evidence that counts, so a duplicated source is a lie about independence.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['templateId', 'sourceId', 'botName', 'config', 'cron'],
          properties: {
            templateId: { type: 'string', description: 'id from the catalog' },
            sourceId: {
              type: 'string',
              description: 'Stable short slug for the upstream feed, e.g. "espn", "draftkings".',
            },
            botName: { type: 'string' },
            config: { type: 'object', description: 'Must satisfy that template’s configSchema.' },
            cron: { type: 'string', description: '5-field cron. Prefer every few minutes for live feeds.' },
          },
        },
      },
      minIndependentSources: {
        type: 'integer',
        description: 'How many distinct sources a claim needs before it can act. 2 unless the user asked otherwise.',
      },
    },
  },
};

const SYSTEM = `You compose a Hive swarm mission from a plain-English request.

A mission is a set of gatherers — one per upstream data source — plus an objective. Downstream roles (analyst, adversary, coordinator) are automatic; you do not configure them.

Rules:
1. Pick gatherers ONLY from the catalog. Never invent a template.
2. One gatherer per source, and every sourceId must be distinct. The whole system ranks claims by how many DISTINCT sources back them, so two gatherers on the same feed would manufacture fake corroboration.
3. Prefer 2-4 gatherers across genuinely different sources over many on one. If the request can only be served by one source, return one and say so in the objective.
4. Fill each config to satisfy its template's configSchema. Use concrete values from the request. Never invent API keys or secrets — leave secret fields out.
5. The objective must state a DECISION the swarm can reach ("flag races where the morning line diverges from closing money"), not a topic ("horse racing").
6. Cron: live feeds every 2-5 minutes, slow ones hourly or daily. Do not schedule anything more often than once a minute.`;

export async function missionComposeRoutes(app: FastifyInstance) {
  app.post('/api/missions/compose', { preHandler: requireRole('admin') }, async (req, reply) => {
    if (!env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({
        error: { code: 'no_model', message: 'ANTHROPIC_API_KEY is not configured' },
      });
    }
    const userId = req.user?.id;
    if (!userId) {
      return reply
        .code(401)
        .send({ error: { code: 'no_session', message: 'a user session is required' } });
    }
    const body = Body.parse(req.body);

    // Only offer templates whose pool has a worker online right now.
    //
    // Without this the composer will happily pick a pool nobody is running,
    // every job sits `queued` forever, and the console shows a full field with
    // zero findings and no explanation — which is the worst possible failure,
    // because it looks like it is working.
    const ONLINE_WINDOW_MS = 30_000;
    const liveWorkers = await prisma.worker.findMany({
      where: { lastSeenAt: { gt: new Date(Date.now() - ONLINE_WINDOW_MS) }, status: { not: 'offline' } },
      select: { poolType: true },
      distinct: ['poolType'],
    });
    const onlinePools = new Set(liveWorkers.map((w) => w.poolType));
    if (onlinePools.size === 0) {
      return reply.code(503).send({
        error: {
          code: 'no_workers',
          message: 'No worker pools are online, so nothing could actually run. Start the workers and try again.',
        },
      });
    }

    const allTemplates = await prisma.botTemplate.findMany({ orderBy: { name: 'asc' } });
    const templates = allTemplates.filter((t) => onlinePools.has(t.poolType));
    if (templates.length === 0) {
      return reply.code(503).send({
        error: {
          code: 'no_usable_templates',
          message: `Online pools (${[...onlinePools].join(', ')}) have no templates to work with.`,
        },
      });
    }
    const catalog = templates.map((t) => ({
      id: t.id,
      name: t.name,
      pool: t.poolType,
      description: t.description,
      configSchema: t.configSchema,
    }));

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: env.HIVE_BOT_BUILDER_MODEL,
      max_tokens: 3000,
      system: SYSTEM,
      tools: [COMPOSE_TOOL],
      tool_choice: { type: 'tool', name: 'compose_mission' },
      messages: [
        {
          role: 'user',
          content: JSON.stringify({ request: body.description, catalog }, null, 2),
        },
      ],
    });

    const block = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'compose_mission',
    );
    if (!block) {
      return reply
        .code(502)
        .send({ error: { code: 'no_plan', message: 'could not compose a mission from that' } });
    }

    const plan = block.input as {
      name?: string;
      domain?: string;
      objective?: string;
      minIndependentSources?: number;
      gatherers?: {
        templateId?: string;
        sourceId?: string;
        botName?: string;
        config?: Record<string, unknown>;
        cron?: string;
      }[];
    };

    const byId = new Map(templates.map((t) => [t.id, t]));
    const seen = new Set<string>();
    const valid: {
      template: (typeof templates)[number];
      sourceId: string;
      botName: string;
      config: Record<string, unknown>;
      cron: string;
    }[] = [];

    for (const g of plan.gatherers ?? []) {
      const template = g.templateId ? byId.get(g.templateId) : undefined;
      const sourceId = (g.sourceId ?? '').trim().toLowerCase();
      if (!template || !sourceId) continue;
      // Enforced here as well as in the prompt: a duplicated source would show
      // up downstream as independent corroboration that does not exist.
      if (seen.has(sourceId)) continue;
      let cron = g.cron ?? '*/5 * * * *';
      try {
        cronParser.parseExpression(cron);
      } catch {
        cron = '*/5 * * * *';
      }
      seen.add(sourceId);
      const coerced = coerceConfigToSchema(template.configSchema, {
        ...((template.defaultConfig ?? {}) as Record<string, unknown>),
        ...(g.config ?? {}),
      });
      valid.push({
        template,
        sourceId,
        botName: g.botName?.trim() || `${template.name} · ${sourceId}`,
        config: coerced.config,
        cron,
      });
    }

    if (valid.length === 0) {
      return reply.code(422).send({
        error: {
          code: 'no_gatherers',
          message: `Nothing that is currently running can watch that. Live pools: ${[...onlinePools].join(', ')}. Try naming a site or feed one of those can reach.`,
        },
      });
    }

    const mission = await prisma.mission.create({
      data: {
        userId,
        name: plan.name?.trim() || 'Untitled mission',
        domain: plan.domain?.trim() || 'general',
        objective: plan.objective?.trim() || body.description,
        // Running immediately — the point of the product is that describing it
        // is the same act as starting it.
        status: 'running',
        // Notify only. Widening is a separate, deliberate admin act.
        allowedActions: ['notify'],
        limits: {
          'mission:actions': 20,
          'action:notify': 10,
          min_independent_sources: Math.max(1, Math.min(4, plan.minIndependentSources ?? 2)),
        } as Prisma.InputJsonValue,
      },
    });

    for (const g of valid) {
      const bot = await prisma.bot.create({
        data: {
          templateId: g.template.id,
          userId,
          name: g.botName,
          config: (await encryptBotConfig(g.template, g.config)) as Prisma.InputJsonValue,
          enabled: true,
        },
      });
      await prisma.missionAgent.create({
        data: {
          missionId: mission.id,
          botId: bot.id,
          role: 'gatherer',
          sourceId: g.sourceId,
          subscribes: [],
        },
      });
      await prisma.schedule.create({
        data: {
          botId: bot.id,
          cron: g.cron,
          enabled: true,
          nextRunAt: cronParser.parseExpression(g.cron).next().toDate(),
        },
      });
    }

    await writeAuditLog(req, {
      userId,
      action: 'mission.compose',
      targetType: 'mission',
      targetId: mission.id,
      payload: { gatherers: valid.length, sources: [...seen] },
    });

    return reply.code(201).send({
      mission,
      gatherers: valid.map((g) => ({
        sourceId: g.sourceId,
        botName: g.botName,
        template: g.template.name,
        cron: g.cron,
      })),
    });
  });
}
