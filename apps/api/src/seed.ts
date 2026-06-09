import { prisma, Prisma } from '@hive/db';
import { hashPassword } from './lib/passwords.js';

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
        apiKey: { type: 'string', format: 'password', 'x-secret': true },
        apiSecret: { type: 'string', format: 'password', 'x-secret': true },
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
        apiKey: { type: 'string', format: 'password', 'x-secret': true },
        apiSecret: { type: 'string', format: 'password', 'x-secret': true },
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
  // ============ mcp_host (Phase 4a) ============
  {
    name: 'Hive MCP Server',
    description: 'Long-running: spins up an MCP server (SSE) on the assigned port, exposes the given exposedBots as MCP tools for durationSeconds. Each tool call invokes the underlying bot via /api/bots/:id/run. See /docs/MCP.md.',
    poolType: 'mcp_host',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['exposedBots'],
      properties: {
        durationSeconds: { type: 'integer', minimum: 1, maximum: 86400, default: 3600 },
        port: { type: 'integer', minimum: 0, maximum: 65535, default: 0, description: '0 = auto-assign' },
        exposedBots: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', description: 'Bot ID' },
        },
        transportMode: { type: 'string', enum: ['sse', 'stdio'], default: 'sse' },
        authToken: { type: 'string', format: 'password', 'x-secret': true, description: 'If set, clients must pass this as Bearer or ?token=' },
      },
    },
    defaultConfig: { durationSeconds: 600, port: 0, exposedBots: [], transportMode: 'sse' },
  },
  {
    name: 'MCP Tool Tester',
    description: 'Short job: connects to an MCP server, calls one tool with the given args, returns the result. Useful for verifying a Hive MCP Server without firing up Claude Desktop.',
    poolType: 'mcp_host',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['mcpServerUrl', 'toolName', 'toolArgs'],
      properties: {
        mcpServerUrl: { type: 'string', format: 'uri', description: 'e.g. http://localhost:4200/sse' },
        authToken: { type: 'string', format: 'password', 'x-secret': true },
        toolName: { type: 'string' },
        toolArgs: { type: 'object', additionalProperties: true },
      },
    },
    defaultConfig: { mcpServerUrl: 'http://localhost:4200/sse', toolName: 'cron_heartbeat', toolArgs: { label: 'mcp-test' } },
  },
  {
    name: 'MCP Server Health Check',
    description: 'Connects to an MCP server, calls list_tools, returns names + latency + whether all expectedTools (if any) are present.',
    poolType: 'mcp_host',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['mcpServerUrl'],
      properties: {
        mcpServerUrl: { type: 'string', format: 'uri' },
        authToken: { type: 'string', format: 'password', 'x-secret': true },
        expectedTools: { type: 'array', items: { type: 'string' }, default: [] },
      },
    },
    defaultConfig: { mcpServerUrl: 'http://localhost:4200/sse', expectedTools: [] },
  },
  // ============ ci_agent (Phase 4a) ============
  {
    name: 'GitHub Repo Test Runner',
    description: 'Clone a Git repo inside a container and run a test command. Streams stdout/stderr to joblog; returns exit code and last 50 lines. Requires Docker daemon access on the worker host.',
    poolType: 'ci_agent',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['repoUrl', 'testCommand'],
      properties: {
        repoUrl: { type: 'string', format: 'uri', description: 'https Git clone URL' },
        ref: { type: 'string', default: 'main' },
        githubToken: { type: 'string', format: 'password', 'x-secret': true, description: 'Personal access token for private repos' },
        testCommand: { type: 'string', description: "e.g. 'pnpm test', 'pytest', 'go test ./...'" },
        dockerImage: { type: 'string', default: 'node:20' },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 7200, default: 600 },
        envVars: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
    defaultConfig: { repoUrl: 'https://github.com/sindresorhus/awesome', ref: 'main', testCommand: 'ls -la', dockerImage: 'ubuntu:24.04', timeoutSeconds: 120 },
  },
  {
    name: 'Docker Image Builder',
    description: 'Clone a repo, docker build an image, optionally push to a registry. Returns image id + size + duration.',
    poolType: 'ci_agent',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['repoUrl', 'imageTag'],
      properties: {
        repoUrl: { type: 'string', format: 'uri' },
        ref: { type: 'string', default: 'main' },
        githubToken: { type: 'string', format: 'password', 'x-secret': true },
        dockerfilePath: { type: 'string', default: 'Dockerfile' },
        buildContext: { type: 'string', default: '.' },
        imageTag: { type: 'string', description: 'e.g. myapp:phase4' },
        buildArgs: { type: 'object', additionalProperties: { type: 'string' } },
        pushTo: { type: 'string', description: 'Registry URL — pushes after build if set' },
        registryUsername: { type: 'string' },
        registryPassword: { type: 'string', format: 'password', 'x-secret': true },
      },
    },
    defaultConfig: { repoUrl: '', ref: 'main', dockerfilePath: 'Dockerfile', buildContext: '.', imageTag: 'hive-build:latest' },
  },
  {
    name: 'Shell Command Runner',
    description: 'Minimal "run this command in a container" template. Useful for ad-hoc tasks.',
    poolType: 'ci_agent',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Single command line — runs under sh -c' },
        dockerImage: { type: 'string', default: 'ubuntu:24.04' },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 3600, default: 300 },
        envVars: { type: 'object', additionalProperties: { type: 'string' } },
        workingDir: { type: 'string', default: '/workspace' },
      },
    },
    defaultConfig: { command: "echo 'hello from hive'", dockerImage: 'ubuntu:24.04', timeoutSeconds: 60, workingDir: '/workspace' },
  },
  // ============ task_runner (Phase 4a) ============
  {
    name: 'Python Script Runner',
    description: 'Write user-supplied Python source to a temp file, optionally create a venv with pipPackages, run with a timeout. Returns exit code + tailed stdout/stderr.',
    poolType: 'task_runner',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['code'],
      properties: {
        code: { type: 'string', description: 'Python source' },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 600, default: 60 },
        pythonVersion: { type: 'string', enum: ['3.11', '3.12'], default: '3.11' },
        pipPackages: { type: 'array', items: { type: 'string' }, default: [] },
        stdin: { type: 'string', description: 'Sent to the script on stdin' },
        envVars: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
    defaultConfig: { code: "print('hello from hive')\n", timeoutSeconds: 30, pythonVersion: '3.11', pipPackages: [] },
  },
  {
    name: 'Shell Command Runner (Native)',
    description: "Run a shell command on the HOST (no container). Faster than ci_agent's Docker version but with no isolation — treat any user-supplied command as RCE. See /docs/POOLS.md.",
    poolType: 'task_runner',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string' },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 600, default: 60 },
        envVars: { type: 'object', additionalProperties: { type: 'string' } },
        workingDir: { type: 'string' },
      },
    },
    defaultConfig: { command: "echo 'hello from hive (native)'", timeoutSeconds: 30 },
  },
  {
    name: 'Generic Webhook Receiver Echo',
    description: 'Spins up an HTTP server on the assigned port for durationSeconds. Every received request is logged via joblog and counted. Useful for confirming another system actually POSTs.',
    poolType: 'task_runner',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        durationSeconds: { type: 'integer', minimum: 1, maximum: 3600, default: 300 },
        port: { type: 'integer', minimum: 0, maximum: 65535, default: 0, description: '0 = auto-assign' },
      },
    },
    defaultConfig: { durationSeconds: 60, port: 0 },
  },
  // ============ browser (Phase 4b) ============
  {
    name: 'Full Page Screenshot',
    description: 'Headless Chromium screenshot of a URL. Uploads PNG as an artifact and returns artifactId + page title.',
    poolType: 'browser',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', format: 'uri' },
        viewportWidth: { type: 'integer', minimum: 320, default: 1440 },
        viewportHeight: { type: 'integer', minimum: 240, default: 900 },
        fullPage: { type: 'boolean', default: true },
        waitForSelector: { type: 'string' },
        waitMs: { type: 'integer', minimum: 0, default: 0 },
        userAgent: { type: 'string' },
      },
    },
    defaultConfig: { url: 'https://example.com', viewportWidth: 1440, viewportHeight: 900, fullPage: true, waitMs: 0 },
  },
  {
    name: 'Headless Form Filler',
    description: 'Sequence of fill/click/select/wait steps. On success captures per `capture` setting; on any step failure ALWAYS captures failure.png + failure.html.',
    poolType: 'browser',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['url', 'steps'],
      properties: {
        url: { type: 'string', format: 'uri' },
        steps: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['action'],
            properties: {
              selector: { type: 'string' },
              action: { type: 'string', enum: ['fill', 'click', 'select', 'wait'] },
              value: { type: 'string' },
              waitMs: { type: 'integer', minimum: 0 },
            },
          },
        },
        finalSelectorWait: { type: 'string' },
        capture: { type: 'string', enum: ['screenshot', 'html', 'both', 'none'], default: 'screenshot' },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 600, default: 30 },
      },
    },
    defaultConfig: {
      url: 'https://httpbin.org/forms/post',
      steps: [
        { selector: 'input[name="custname"]', action: 'fill', value: 'hive' },
        { selector: 'input[type="submit"]', action: 'click' },
      ],
      capture: 'screenshot',
      timeoutSeconds: 30,
    },
  },
  {
    name: 'E2E Test Runner',
    description: 'Load URL, run a list of assertions (expectVisible / expectText / expectAttribute). Job succeeds even when failed>0 — failures are data, not infra errors.',
    poolType: 'browser',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['url', 'assertions'],
      properties: {
        url: { type: 'string', format: 'uri' },
        assertions: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['selector'],
            properties: {
              selector: { type: 'string' },
              expectVisible: { type: 'boolean' },
              expectText: { type: 'string' },
              expectAttribute: {
                type: 'object',
                required: ['name', 'value'],
                properties: { name: { type: 'string' }, value: { type: 'string' } },
              },
            },
          },
        },
        viewportWidth: { type: 'integer', default: 1440 },
        viewportHeight: { type: 'integer', default: 900 },
        captureOnFailure: { type: 'boolean', default: true },
      },
    },
    defaultConfig: {
      url: 'https://example.com',
      assertions: [{ selector: 'h1', expectText: 'Example Domain' }],
      captureOnFailure: true,
    },
  },
  {
    name: 'Web Element Extractor',
    description: 'JS-rendered scraping: load URL, return extracted values from a selectors map. attr defaults to textContent; multiple returns an array.',
    poolType: 'browser',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['url', 'selectors'],
      properties: {
        url: { type: 'string', format: 'uri' },
        selectors: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['name', 'selector'],
            properties: {
              name: { type: 'string' },
              selector: { type: 'string' },
              attr: { type: 'string' },
              multiple: { type: 'boolean', default: false },
            },
          },
        },
        waitForSelector: { type: 'string' },
        userAgent: { type: 'string' },
      },
    },
    defaultConfig: {
      url: 'https://example.com',
      selectors: [{ name: 'title', selector: 'h1' }],
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

async function seedAdmin(): Promise<void> {
  const adminCount = await prisma.user.count({ where: { role: 'admin' } });
  if (adminCount > 0) {
    console.log(`✓ admin user already present (${adminCount} admin${adminCount === 1 ? '' : 's'} found)`);
    return;
  }
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'no admin user exists and ADMIN_EMAIL / ADMIN_PASSWORD are not set — refusing to leave Hive without an admin',
    );
  }
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      displayName: email.split('@')[0],
      role: 'admin',
    },
  });
  console.log(`✓ seeded admin user "${email}" (${user.id})`);
}

async function main() {
  for (const t of TEMPLATES) await upsertTemplate(t);
  await seedAdmin();
}

main()
  .catch((err) => {
    console.error('seed_failed', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
