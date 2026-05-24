import { prisma } from '@hive/db';

const ESPN_TEMPLATE = {
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
};

async function main() {
  const existing = await prisma.botTemplate.findFirst({ where: { name: ESPN_TEMPLATE.name } });
  if (existing) {
    const updated = await prisma.botTemplate.update({
      where: { id: existing.id },
      data: {
        description: ESPN_TEMPLATE.description,
        poolType: ESPN_TEMPLATE.poolType,
        configSchema: ESPN_TEMPLATE.configSchema,
        defaultConfig: ESPN_TEMPLATE.defaultConfig,
      },
    });
    console.log(`✓ updated template ${updated.id} (${updated.name})`);
  } else {
    const created = await prisma.botTemplate.create({ data: ESPN_TEMPLATE });
    console.log(`✓ seeded template ${created.id} (${created.name})`);
  }
}

main()
  .catch((err) => {
    console.error('seed_failed', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
