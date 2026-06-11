import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@hive/db';
import { requireRole } from '../auth.js';
import { env } from '../env.js';
import { coerceConfigToSchema } from '../lib/schema-coerce.js';

const SuggestBody = z.object({
  description: z.string().min(3).max(4000),
});

// The shape we force Claude to return via tool-use. Keeping `config` an open
// object (the per-template schema is described in the prompt) and validating it
// ourselves afterward is more robust than trying to feed N distinct schemas.
const PROPOSE_TOOL: Anthropic.Tool = {
  name: 'propose_bot',
  description:
    'Propose a single bot to create, chosen from the provided template catalog, with a config that satisfies that template’s schema.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['templateId', 'botName', 'config', 'rationale'],
    properties: {
      templateId: {
        type: 'string',
        description: 'The id of the single best-fit template from the catalog.',
      },
      botName: {
        type: 'string',
        description: 'A short, human-friendly name for this bot (e.g. "NBA Scores — Tonight").',
      },
      config: {
        type: 'object',
        description:
          'Config object whose keys/values match the chosen template’s configSchema. Use real values inferred from the request; never invent secrets or API keys (leave secret fields out).',
      },
      rationale: {
        type: 'string',
        description: 'One or two sentences explaining why this template fits the request.',
      },
    },
  },
};

const SYSTEM_PROMPT = `You turn a plain-English description into ONE Hive bot.

Hive runs bots from a fixed catalog of templates. Each template has an id, a pool, a description, and a JSON-Schema "configSchema" describing its parameters. You do NOT write code — you pick the single best-fit template and fill in a config that satisfies its schema.

Rules:
- Choose exactly one template from the catalog. If several could work, pick the closest match.
- Produce a config object whose keys match the chosen template's configSchema. Respect enums, types, required fields, and min/max. Prefer the schema's defaults when the request doesn't specify a value.
- NEVER invent secrets, API keys, tokens, passwords, or credentials. Leave any secret/credential field out of the config — the operator fills those in.
- Give the bot a concise, descriptive name.
- If nothing in the catalog reasonably fits, still pick the closest template and say so in the rationale.
- Always respond by calling the propose_bot tool.`;

interface CatalogTemplate {
  id: string;
  name: string;
  description: string | null;
  poolType: string;
  configSchema: unknown;
}

function buildUserPrompt(description: string, templates: CatalogTemplate[]): string {
  const catalog = templates
    .map(
      (t) =>
        `### ${t.name}\nid: ${t.id}\npool: ${t.poolType}\npurpose: ${t.description ?? '(none)'}\nconfigSchema: ${JSON.stringify(t.configSchema)}`,
    )
    .join('\n\n');
  return `TEMPLATE CATALOG (${templates.length} templates):\n\n${catalog}\n\n---\n\nUSER REQUEST:\n${description}\n\nPick the single best-fit template and propose a bot via the propose_bot tool.`;
}

export async function botBuilderRoutes(app: FastifyInstance) {
  // Suggesting a bot calls a paid LLM and is the on-ramp to creating an
  // executable bot — admin-only, same as bot creation itself.
  app.post('/api/bot-builder/suggest', { preHandler: requireRole('admin') }, async (req, reply) => {
    if (!env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({
        error: {
          code: 'ai_unconfigured',
          message:
            'The AI bot builder needs ANTHROPIC_API_KEY set on the API service. Add it and redeploy, or create the bot manually from a template.',
        },
      });
    }
    const body = SuggestBody.parse(req.body);

    const templates = await prisma.botTemplate.findMany({
      select: { id: true, name: true, description: true, poolType: true, configSchema: true },
      orderBy: { name: 'asc' },
    });
    if (templates.length === 0) {
      return reply.code(409).send({
        error: { code: 'no_templates', message: 'No templates exist to build a bot from. Seed templates first.' },
      });
    }

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    let msg: Anthropic.Message;
    try {
      msg = await client.messages.create({
        model: env.HIVE_BOT_BUILDER_MODEL,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        tools: [PROPOSE_TOOL],
        tool_choice: { type: 'tool', name: 'propose_bot' },
        messages: [{ role: 'user', content: buildUserPrompt(body.description, templates) }],
      });
    } catch (e) {
      req.log.error({ err: e }, 'bot_builder_llm_failed');
      return reply.code(502).send({
        error: { code: 'ai_failed', message: `The AI request failed: ${(e as Error).message}` },
      });
    }

    const toolUse = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'propose_bot',
    );
    if (!toolUse) {
      return reply.code(502).send({
        error: { code: 'ai_no_proposal', message: 'The AI did not return a usable proposal. Try rephrasing.' },
      });
    }

    const proposal = toolUse.input as {
      templateId?: string;
      botName?: string;
      config?: unknown;
      rationale?: string;
    };
    const template = templates.find((t) => t.id === proposal.templateId);
    if (!template) {
      return reply.code(502).send({
        error: { code: 'ai_bad_template', message: 'The AI picked a template that no longer exists. Try again.' },
      });
    }

    const { config, warnings } = coerceConfigToSchema(template.configSchema, proposal.config);

    return reply.send({
      templateId: template.id,
      templateName: template.name,
      poolType: template.poolType,
      botName: (proposal.botName ?? template.name).slice(0, 120),
      config,
      rationale: proposal.rationale ?? '',
      warnings,
    });
  });
}
