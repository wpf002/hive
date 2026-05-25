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
    name: 'Sportsbook Line Scraper',
    description: 'Pull current odds for one book / league via the-odds-api.com and reshape to a uniform schema. Requires ODDS_API_KEY.',
    poolType: 'scraper',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['book', 'league'],
      properties: {
        book: { type: 'string', enum: ['draftkings', 'fanduel'] },
        league: { type: 'string', enum: ['nfl', 'nba', 'mlb', 'nhl'] },
        markets: {
          type: 'array',
          items: { type: 'string', enum: ['moneyline', 'spread', 'total'] },
          default: ['moneyline', 'spread', 'total'],
        },
      },
    },
    defaultConfig: {
      book: 'draftkings',
      league: 'nfl',
      markets: ['moneyline', 'spread', 'total'],
    },
  },
  {
    name: 'AI Single Call',
    description: 'One-shot call to a single AI provider (Claude / GPT / Perplexity). Returns response + token usage + cost. Set stream=true to publish each chunk via joblog (renders incrementally in the AI Console). Perplexity streaming is not supported in this phase — the worker silently falls back to one chunk.',
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
        stream: { type: 'boolean', default: false, description: 'Streaming text via ai.chunk events (Claude + GPT only).' },
      },
    },
    defaultConfig: {
      provider: 'claude',
      userPrompt: 'What is 2+2? Answer in one word.',
      maxTokens: 256,
      temperature: 0.7,
      stream: false,
    },
  },
  {
    name: 'AI Multi-Provider Verdict',
    description: 'Fans the same prompt out to multiple AI providers in parallel, then synthesizes a verdict. Streaming is not supported in this phase (multi-provider chunking UX deferred).',
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
  {
    name: 'HTTP Endpoint Monitor',
    description: 'Ping an HTTP endpoint and assert status / optional body match. "down" returns ok=false; only infrastructure errors fail the job.',
    poolType: 'monitor',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', format: 'uri' },
        method: { type: 'string', enum: ['GET', 'HEAD', 'POST'], default: 'GET' },
        expectedStatus: { type: 'integer', minimum: 100, maximum: 599, default: 200 },
        timeoutMs: { type: 'integer', minimum: 100, default: 10000 },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'string' },
        checkBodyContains: { type: 'string' },
      },
    },
    defaultConfig: {
      url: 'https://example.com',
      method: 'GET',
      expectedStatus: 200,
      timeoutMs: 10000,
    },
  },
  {
    name: 'Cron Heartbeat',
    description: 'Minimal monitor template — echoes a label, returns timestamp + hostname. Useful as a "Hive is alive" signal.',
    poolType: 'monitor',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['label'],
      properties: {
        label: { type: 'string' },
        payload: { type: 'object' },
      },
    },
    defaultConfig: { label: 'hive', payload: {} },
  },
  // ============ Discord (Phase 3a) ============
  // Note: botToken is stored plaintext in config in dev. Phase 4 will encrypt
  // secrets at rest with libsodium or pgcrypto.
  {
    name: 'Discord Channel Poster',
    description: 'Post a message (optionally with embed + mentions) to a Discord channel. Bot must be in the guild with Send Messages perm. Token is stored plaintext in dev — Phase 4 will encrypt secrets at rest.',
    poolType: 'discord',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['botToken', 'channelId', 'content'],
      properties: {
        botToken: { type: 'string', format: 'password', description: 'Discord bot token (secret)' },
        channelId: { type: 'string', description: 'Numeric channel ID' },
        content: { type: 'string', maxLength: 2000, description: 'Message body (markdown allowed)' },
        embed: {
          type: 'object',
          description: 'Optional embed object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            color: { type: 'integer', description: 'Hex int (e.g. 0xFFC107)' },
            fields: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  value: { type: 'string' },
                  inline: { type: 'boolean' },
                },
              },
            },
          },
        },
        mentions: { type: 'array', items: { type: 'string' }, description: 'User IDs to ping' },
      },
    },
    defaultConfig: { botToken: '', channelId: '', content: 'Hello from Hive 🐝' },
  },
  {
    name: 'Discord DM Sender',
    description: 'Open a DM channel with a Discord user and send a message. User must share a guild with the bot. Token is stored plaintext in dev.',
    poolType: 'discord',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['botToken', 'userId', 'content'],
      properties: {
        botToken: { type: 'string', format: 'password' },
        userId: { type: 'string', description: 'Numeric Discord user ID' },
        content: { type: 'string', maxLength: 2000 },
      },
    },
    defaultConfig: { botToken: '', userId: '', content: 'Hello from Hive 🐝' },
  },
  {
    name: 'Discord Slash Command Listener',
    description: 'Long-running: registers /commandName on a guild and replies to invocations for durationSeconds using a Jinja-style template. Logs each invocation. Tagged discord_long_running.',
    poolType: 'discord',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['botToken', 'guildId', 'commandName', 'commandDescription', 'responseTemplate'],
      properties: {
        botToken: { type: 'string', format: 'password' },
        guildId: { type: 'string' },
        commandName: {
          type: 'string',
          pattern: '^[a-z0-9_-]{1,32}$',
          description: 'Lowercase, no spaces, max 32 chars',
        },
        commandDescription: { type: 'string', maxLength: 100 },
        responseTemplate: {
          type: 'string',
          description: 'Reply body. Use {{ argName }} for placeholders.',
        },
        argSchema: {
          type: 'array',
          default: [],
          items: {
            type: 'object',
            required: ['name', 'description', 'type'],
            properties: {
              name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,31}$' },
              description: { type: 'string' },
              required: { type: 'boolean', default: false },
              type: { type: 'string', enum: ['string', 'int', 'bool'] },
            },
          },
        },
        durationSeconds: { type: 'integer', minimum: 1, maximum: 86400, default: 3600 },
      },
    },
    defaultConfig: {
      botToken: '',
      guildId: '',
      commandName: 'hivetest',
      commandDescription: 'Hive test command',
      responseTemplate: 'pong — Hive heard you, {{ name }}',
      argSchema: [{ name: 'name', description: 'Your name', required: true, type: 'string' }],
      durationSeconds: 300,
    },
  },
  // ============ Telegram (Phase 3a) ============
  {
    name: 'Telegram Channel Poster',
    description: 'Send a message to a Telegram channel or group. parseMode default MarkdownV2 — remember to escape MarkdownV2 reserved chars. Token is stored plaintext in dev.',
    poolType: 'telegram',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['botToken', 'chatId', 'content'],
      properties: {
        botToken: { type: 'string', format: 'password' },
        chatId: { type: 'string', description: 'Channel @handle or numeric chat ID' },
        content: { type: 'string', maxLength: 4096 },
        parseMode: { type: 'string', enum: ['MarkdownV2', 'HTML', 'plain'], default: 'MarkdownV2' },
        disableNotification: { type: 'boolean', default: false },
        disablePreview: { type: 'boolean', default: false },
      },
    },
    defaultConfig: { botToken: '', chatId: '', content: 'Hello from Hive', parseMode: 'plain' },
  },
  {
    name: 'Telegram DM Alerter',
    description: 'Personal page-me style alerts to a Telegram user with severity prefix (info/warn/critical). User must have started a chat with the bot first.',
    poolType: 'telegram',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['botToken', 'userId', 'content'],
      properties: {
        botToken: { type: 'string', format: 'password' },
        userId: { type: 'string', description: 'Numeric Telegram user ID' },
        content: { type: 'string', maxLength: 4096 },
        parseMode: { type: 'string', enum: ['MarkdownV2', 'HTML', 'plain'], default: 'MarkdownV2' },
        severity: { type: 'string', enum: ['info', 'warn', 'critical'], default: 'info' },
        prefix: { type: 'boolean', default: true, description: 'Prepend emoji + severity tag' },
      },
    },
    defaultConfig: {
      botToken: '',
      userId: '',
      content: 'Hive alert — test page',
      parseMode: 'plain',
      severity: 'info',
      prefix: true,
    },
  },
  // ============ Trading (Phase 3b) ============
  {
    name: 'Trading Market Order',
    description: 'Place a market buy/sell order. Default paper mode simulates against PaperWallet. Live mode requires TRADING_LIVE_ENABLED=true plus API keys; always records a TradeAudit row.',
    poolType: 'trading',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['exchange', 'symbol', 'side', 'amount'],
      properties: {
        exchange: { type: 'string', enum: ['binance', 'coinbase', 'kraken'] },
        symbol: { type: 'string', description: 'e.g. BTC/USDT' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        amount: { type: 'number', exclusiveMinimum: 0 },
        mode: { type: 'string', enum: ['paper', 'live'], default: 'paper' },
        apiKey: { type: 'string', format: 'password' },
        apiSecret: { type: 'string', format: 'password' },
        maxSlippagePct: { type: 'number', default: 1.0, description: 'Reject fill if price moved >x% from quote' },
      },
    },
    defaultConfig: { exchange: 'binance', symbol: 'BTC/USDT', side: 'buy', amount: 0.001, mode: 'paper', maxSlippagePct: 1.0 },
  },
  {
    name: 'Trading Portfolio Snapshot',
    description: 'Read-only balances per exchange. Paper mode reads PaperWallet rows; live mode reads ccxt.fetchBalance(). No writes.',
    poolType: 'trading',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['exchange'],
      properties: {
        exchange: { type: 'string', enum: ['binance', 'coinbase', 'kraken'] },
        mode: { type: 'string', enum: ['paper', 'live'], default: 'paper' },
        apiKey: { type: 'string', format: 'password' },
        apiSecret: { type: 'string', format: 'password' },
        symbols: { type: 'array', items: { type: 'string' } },
        includeUsd: { type: 'boolean', default: true },
      },
    },
    defaultConfig: { exchange: 'binance', mode: 'paper', includeUsd: true },
  },
  {
    name: 'Arbitrage Watcher',
    description: 'Read-only: watches a symbol across 2+ exchanges for durationSeconds; logs every observation, flags spreads ≥ minSpreadPct, optionally POSTs JSON to alertWebhookUrl. Never auto-trades.',
    poolType: 'trading',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['exchanges', 'symbol'],
      properties: {
        exchanges: {
          type: 'array',
          minItems: 2,
          items: { type: 'string', enum: ['binance', 'coinbase', 'kraken'] },
        },
        symbol: { type: 'string' },
        minSpreadPct: { type: 'number', default: 0.5 },
        durationSeconds: { type: 'integer', minimum: 5, maximum: 3600, default: 300 },
        alertWebhookUrl: { type: 'string', format: 'uri' },
      },
    },
    defaultConfig: { exchanges: ['binance', 'kraken'], symbol: 'BTC/USDT', minSpreadPct: 0.5, durationSeconds: 60 },
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
