import { prisma, Prisma } from '@hive/db';

type SeedTemplate = {
  name: string;
  description: string;
  poolType: string;
  configSchema: Prisma.InputJsonValue;
  defaultConfig: Prisma.InputJsonValue;
};

const TEMPLATES: SeedTemplate[] = [
  {
    name: 'ESPN Scoreboard Scraper',
    description: 'Fetch a day of games from the public ESPN scoreboard API for one league.',
    poolType: 'scraper',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['league', 'dateOffset'],
      properties: {
        league: {
          type: 'string',
          enum: ['nfl', 'nba', 'mlb', 'nhl', 'wnba'],
          description: 'Sport league code.',
        },
        dateOffset: {
          type: 'integer',
          description: 'Days from today. 0 = today, -1 = yesterday, 1 = tomorrow.',
        },
      },
    },
    defaultConfig: { league: 'nfl', dateOffset: 0 },
  },
  {
    name: 'AI Single Call',
    description: 'One-shot call to a single AI provider (Claude / GPT / Perplexity). Returns response + token usage + cost.',
    poolType: 'ai_agent',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['provider', 'userPrompt'],
      properties: {
        provider: { type: 'string', enum: ['claude', 'gpt', 'perplexity'] },
        model: { type: 'string', description: 'Override default model for this provider.' },
        systemPrompt: { type: 'string' },
        userPrompt: { type: 'string' },
        maxTokens: { type: 'integer', minimum: 1, default: 2048 },
        temperature: { type: 'number', minimum: 0, maximum: 2, default: 0.7 },
        jsonMode: { type: 'boolean', default: false },
      },
    },
    defaultConfig: {
      provider: 'claude',
      userPrompt: 'What is 2+2? Answer in one word.',
      maxTokens: 256,
      temperature: 0.7,
    },
  },
  {
    name: 'AI Multi-Provider Verdict',
    description: 'Fans the same prompt out to multiple AI providers in parallel, then synthesizes a verdict.',
    poolType: 'ai_agent',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['userPrompt'],
      properties: {
        providers: {
          type: 'array',
          minItems: 2,
          items: { type: 'string', enum: ['claude', 'gpt', 'perplexity'] },
          default: ['claude', 'gpt', 'perplexity'],
        },
        systemPrompt: { type: 'string' },
        userPrompt: { type: 'string' },
        maxTokens: { type: 'integer', minimum: 1, default: 2048 },
        temperature: { type: 'number', minimum: 0, maximum: 2, default: 0.7 },
        verdictMode: { type: 'string', enum: ['consensus', 'best', 'all'], default: 'consensus' },
      },
    },
    defaultConfig: {
      providers: ['claude', 'gpt', 'perplexity'],
      userPrompt: 'What is the capital of France?',
      verdictMode: 'consensus',
      maxTokens: 512,
      temperature: 0.3,
    },
  },
];

async function upsertTemplate(t: SeedTemplate): Promise<void> {
  const existing = await prisma.botTemplate.findFirst({ where: { name: t.name } });
  if (existing) {
    await prisma.botTemplate.update({
      where: { id: existing.id },
      data: {
        description: t.description,
        poolType: t.poolType,
        configSchema: t.configSchema,
        defaultConfig: t.defaultConfig,
      },
    });
    console.log(`✓ updated ${t.poolType} template "${t.name}" (${existing.id})`);
  } else {
    const created = await prisma.botTemplate.create({ data: t });
    console.log(`✓ seeded ${t.poolType} template "${t.name}" (${created.id})`);
  }
}

async function main() {
  for (const t of TEMPLATES) await upsertTemplate(t);
}

main()
  .catch((err) => {
    console.error('seed_failed', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
