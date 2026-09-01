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
import { staggerCron } from '../lib/cron-stagger.js';

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
 * Scale is the cross product of sources and subjects. A source is where the
 * evidence comes from (espn, draftkings); a subject is the entity being watched
 * (one game, one ticker, one host). Three sources over a hundred subjects is
 * three hundred bots, and every claim still has to clear the same bar: distinct
 * sources agreeing about ONE subject. That is the only way the bot count can
 * grow without the evidence getting weaker — more bots on the same
 * (source, subject) pair would be one signal counted twice, which is the failure
 * the whole design exists to prevent.
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
      subjects: {
        type: 'array',
        description:
          'The individual entities to watch — tickers, games, hosts, repos. Every source is pointed at every subject, so this is what makes a swarm big: 3 sources x 80 subjects is 240 bots. Leave empty ONLY when the request is genuinely about one thing. Extract them from the request; if the user named a category rather than a list ("the S&P tech names"), enumerate the concrete members you are confident about.',
        items: { type: 'string' },
      },
      gatherers: {
        type: 'array',
        description:
          'One per distinct upstream source, 2 to 5. Two gatherers must never share a sourceId — corroboration across sources is the only evidence that counts, so a duplicated source is a lie about independence. These are multiplied by `subjects`; do not add one gatherer per subject yourself.',
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
            subjectField: {
              type: 'string',
              description:
                'The key in this template’s configSchema that names one entity — "symbol", "url", "repoUrl", "query". Each subject is written into this key to produce one bot. Required whenever `subjects` is non-empty: a source that cannot be aimed at a subject cannot corroborate anything about it, and will be dropped.',
            },
            subjectTemplate: {
              type: 'string',
              description:
                'Optional. Use when the subject must be embedded rather than used raw, with {subject} as the placeholder — e.g. "https://status.example.com/{subject}/health". Omit to write the subject in verbatim.',
            },
            botName: { type: 'string' },
            config: {
              type: 'object',
              description:
                'Must satisfy that template’s configSchema. Fill everything EXCEPT subjectField, which is filled per subject.',
            },
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

A mission is a grid: SOURCES x SUBJECTS. A source is where evidence comes from (espn, draftkings, nasdaq). A subject is one entity being watched (one game, one ticker, one host). Every source is pointed at every subject, so the swarm's size is the product of the two. Downstream roles (analyst, adversary, coordinator) are automatic; you do not configure them.

Rules:
1. Pick gatherers ONLY from the catalog. Never invent a template.
2. One gatherer per source, and every sourceId must be distinct. The whole system ranks claims by how many DISTINCT sources back them, so two gatherers on the same feed would manufacture fake corroboration.
3. Prefer 2-4 gatherers across genuinely different sources over many on one. If the request can only be served by one source, return one and say so in the objective.
4. Fill each config to satisfy its template's configSchema. Use concrete values from the request. Never invent API keys or secrets — leave secret fields out.
5. The objective must state a DECISION the swarm can reach ("flag races where the morning line diverges from closing money"), not a topic ("horse racing").
6. Cron: live feeds every 2-5 minutes, slow ones hourly or daily. Do not schedule anything more often than once a minute.
7. Breadth belongs in "subjects", never in extra gatherers. To watch 80 tickers you return the SAME 3 gatherers and 80 subjects — not 240 gatherers. Adding near-duplicate gatherers on one feed is the specific mistake this system is built to reject.
8. Whenever you return subjects, every gatherer needs a "subjectField" naming the config key that identifies one entity. A source with no such key cannot be aimed at a subject and will be dropped, so prefer templates that have one.
9. Be generous with subjects when the request implies breadth ("all the majors", "our endpoints", "the top names"). Being wide is cheap — gatherers are plain HTTP jobs. Being wide on the SAME subject is not wide at all.`;

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
      subjects?: string[];
      gatherers?: {
        templateId?: string;
        sourceId?: string;
        subjectField?: string;
        subjectTemplate?: string;
        botName?: string;
        config?: Record<string, unknown>;
        cron?: string;
      }[];
    };

    // Case-insensitive dedup, original casing kept for display. Two subjects
    // differing only in case would be two bots on one entity — the duplicate
    // this whole design refuses.
    const subjects: string[] = [];
    const subjectSeen = new Set<string>();
    for (const raw of plan.subjects ?? []) {
      const subject = String(raw ?? '').trim();
      if (!subject || subject.length > 120) continue;
      const key = subject.toLowerCase();
      if (subjectSeen.has(key)) continue;
      subjectSeen.add(key);
      subjects.push(subject);
    }

    const byId = new Map(templates.map((t) => [t.id, t]));
    const seen = new Set<string>();
    const skipped: { sourceId: string; reason: string }[] = [];
    const sources: {
      template: (typeof templates)[number];
      sourceId: string;
      subjectField: string | null;
      subjectTemplate: string | null;
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

      // A fanned-out mission needs every source aimed at every subject. A source
      // that has no key to aim is dropped rather than quietly added as a
      // whole-feed gatherer: it would contribute findings that belong to no
      // subject, corroborate nothing, and make the mission look wider than the
      // evidence actually is.
      const props = configProperties(template.configSchema);
      const subjectField = (g.subjectField ?? '').trim();
      if (subjects.length > 0) {
        if (!subjectField || !props.has(subjectField)) {
          skipped.push({
            sourceId,
            reason: subjectField
              ? `"${subjectField}" is not a config field on ${template.name}`
              : `${template.name} was given no field to aim at a subject`,
          });
          continue;
        }
      }
      // A pattern without the placeholder would write the same literal into
      // every bot, so every subject would end up watching one thing.
      const subjectTemplate =
        g.subjectTemplate && g.subjectTemplate.includes('{subject}') ? g.subjectTemplate : null;

      seen.add(sourceId);
      sources.push({
        template,
        sourceId,
        subjectField: subjects.length > 0 ? subjectField : null,
        subjectTemplate,
        botName: g.botName?.trim() || `${template.name} · ${sourceId}`,
        config: { ...((template.defaultConfig ?? {}) as Record<string, unknown>), ...(g.config ?? {}) },
        cron,
      });
    }

    if (sources.length === 0) {
      return reply.code(422).send({
        error: {
          code: 'no_gatherers',
          message:
            skipped.length > 0
              ? `No live source can be aimed at those subjects. ${skipped.map((x) => `${x.sourceId}: ${x.reason}`).join('; ')}.`
              : `Nothing that is currently running can watch that. Live pools: ${[...onlinePools].join(', ')}. Try naming a site or feed one of those can reach.`,
        },
      });
    }

    // Trim SUBJECTS, never sources, when the grid exceeds the cap.
    //
    // Dropping a source costs corroboration on every subject at once — the
    // mission would still be wide but nothing in it could clear a two-source
    // bar. Dropping a subject costs only that subject. So the cap narrows
    // coverage and never weakens evidence.
    const perSource = Math.floor(env.MISSION_MAX_GATHERERS / sources.length);
    if (subjects.length > 0 && perSource < 1) {
      return reply.code(422).send({
        error: {
          code: 'too_many_sources',
          message: `${sources.length} sources exceeds the ${env.MISSION_MAX_GATHERERS}-bot cap before any subject is added.`,
        },
      });
    }
    const droppedSubjects = Math.max(0, subjects.length - perSource);
    const usedSubjects = subjects.length > 0 ? subjects.slice(0, perSource) : [''];

    // The grid. One bot per (source, subject) — the unit the dedup key and the
    // independence count are both defined on.
    const valid = sources.flatMap((src) =>
      usedSubjects.map((subject) => {
        const config = { ...src.config };
        if (src.subjectField && subject) {
          config[src.subjectField] = src.subjectTemplate
            ? src.subjectTemplate.replaceAll('{subject}', subject)
            : subject;
        }
        return {
          template: src.template,
          sourceId: src.sourceId,
          subject,
          botName: subject ? `${src.template.name} · ${src.sourceId} · ${subject}` : src.botName,
          config: coerceConfigToSchema(src.template.configSchema, config).config,
          cron: src.cron,
        };
      }),
    );

    // Spread the fleet across the cron interval instead of firing it as one
    // volley. Two hundred bots all on */5 queue two hundred jobs on the same
    // second, five minutes of silence, then another two hundred — the pools
    // spike and the field pulses instead of flowing. Offsetting the start
    // minute turns that into a steady arrival rate for the same total work.
    const staggered = valid.map((g, i) => ({ ...g, cron: staggerCron(g.cron, i) }));

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

    // Batched rather than three queries per bot: a 200-bot grid is 600 round
    // trips one at a time, which is slow enough that the request times out and
    // leaves a half-built mission behind. createManyAndReturn gives back the
    // generated ids, which is what the agent and schedule rows need.
    const encrypted = await Promise.all(
      staggered.map(async (g) => ({
        templateId: g.template.id,
        userId,
        name: g.botName,
        config: (await encryptBotConfig(g.template, g.config)) as Prisma.InputJsonValue,
        enabled: true,
      })),
    );
    const bots = await prisma.bot.createManyAndReturn({
      data: encrypted,
      select: { id: true },
    });

    await prisma.missionAgent.createMany({
      data: staggered.map((g, i) => ({
        missionId: mission.id,
        botId: bots[i].id,
        role: 'gatherer',
        sourceId: g.sourceId,
        subject: g.subject,
        subscribes: [],
      })),
    });
    await prisma.schedule.createMany({
      data: staggered.map((g, i) => ({
        botId: bots[i].id,
        cron: g.cron,
        enabled: true,
        nextRunAt: cronParser.parseExpression(g.cron).next().toDate(),
      })),
    });

    await writeAuditLog(req, {
      userId,
      action: 'mission.compose',
      targetType: 'mission',
      targetId: mission.id,
      payload: {
        gatherers: staggered.length,
        sources: [...seen],
        subjects: usedSubjects.filter(Boolean).length,
        droppedSubjects,
      },
    });

    return reply.code(201).send({
      mission,
      // The grid, not a row per bot: two hundred near-identical entries would
      // bury the one thing the operator needs to see, which is how wide this
      // actually got and whether anything was left out.
      sources: sources.map((src) => ({
        sourceId: src.sourceId,
        template: src.template.name,
        cron: src.cron,
      })),
      subjects: usedSubjects.filter(Boolean),
      gatherers: staggered.length,
      // Silence here would read as "everything you asked for is running".
      skippedSources: skipped,
      droppedSubjects,
    });
  });
}

/** Top-level config keys a template accepts, for validating `subjectField`. */
function configProperties(schema: unknown): Set<string> {
  const props = (schema as { properties?: Record<string, unknown> } | null)?.properties;
  return new Set(props && typeof props === 'object' ? Object.keys(props) : []);
}
