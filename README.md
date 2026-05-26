# 🐝 Hive

Distributed bot orchestration platform. One control plane, eleven worker pools, unlimited bot templates, scales from a single Mac to a cloud fleet.

```
              ┌─────────────────────────────────────┐
              │   UI (Next.js, dark hex aesthetic)  │
              └──────────────────┬──────────────────┘
                                 │
              ┌──────────────────┴──────────────────┐
              │   API (Fastify) + Dispatcher        │
              └──────────────────┬──────────────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 │  Postgres (state)             │
                 │  Redis   (queue + pubsub)     │
                 └───────────────┬───────────────┘
                                 │
   ┌─────────┬─────────┬─────────┴─────────┬─────────┬─────────┐
   │ browser │ scraper │ rpa-desktop │ ... │  ai-agent (TS)    │
   │ (PY)    │ (PY)    │ (PY)        │     │  trading  (TS)    │
   └─────────┴─────────┴─────────────┴─────┴───────────────────┘
                        11 worker pools
```

## Worker pools

| Pool | Stack | Purpose |
|---|---|---|
| `browser` | Python + Playwright | Headless fleets, end-to-end testing, web RPA |
| `scraper` | Python + httpx / Scrapy | API + HTML scraping, sportsbook lines, ESPN |
| `rpa_desktop` | Python + pyautogui | Desktop app + legacy system automation |
| `discord` | Python + discord.py | Discord bots you own |
| `telegram` | Python + python-telegram-bot | Telegram bots you own |
| `trading` | TypeScript + ccxt | Market making, arbitrage, Crossbar order placement |
| `monitor` | Python + apscheduler | Uptime, alerting, cron-style health checks |
| `mcp_host` | TypeScript + MCP SDK | Fleet of MCP servers; exposes Hive bots as MCP tools |
| `ci_agent` | Python + Docker SDK | CI runners, build agents, test executors |
| `task_runner` | Python + arq | Generic distributed task execution |
| `ai_agent` | TypeScript + Anthropic / OpenAI / Perplexity | Claude / GPT / Perplexity as callable resources — single-shot, parallel, chained |

## Concepts

- **BotTemplate** — a reusable recipe (e.g., "ESPN Scoreboard Scraper"). Declares its pool and config schema.
- **Bot** — an instantiated template with concrete params. Has a name, owner, enabled flag.
- **Job** — a single execution of a bot. Has status, payload, result, logs.
- **Schedule** — cron-style recurring trigger for a bot.
- **Worker** — a process in a pool that pulls jobs and executes them. Many per pool.

## Quickstart

```bash
# 1. Clone + env
git clone https://github.com/wpf002/hive.git
cd hive
cp .env.example .env   # fill in ANTHROPIC_API_KEY, OPENAI_API_KEY, PERPLEXITY_API_KEY, etc.

# 2. Infrastructure
make docker-up         # Postgres + Redis

# 3. Dependencies
pnpm install           # TypeScript packages
make workers-install   # Python virtualenvs for each worker pool

# 4. Database
make db-migrate

# 5. Run
make dev               # API + UI + dispatcher
make workers-dev       # all worker pools (separate terminal)
```

UI: http://localhost:3001
API: http://localhost:4000

### Git hooks

A pre-push hook runs `pnpm verify` (typecheck + lint) before allowing a push. Install once after cloning:

```bash
bash scripts/install-git-hooks.sh
```

Bypass with `git push --no-verify` if you need to push WIP. The hook lives in `scripts/git-hooks/` so it's tracked in git; `.git/hooks/` is not.

## Capacity guidance (local, single Mac)

| Workload | Realistic concurrent |
|---|---|
| Headless browsers | 20–50 |
| API scrapers | 500–2000 |
| Discord / Telegram bots | 50–100+ |
| Desktop RPA | 1 per machine (shares mouse/keyboard) |
| Trading / monitor loops | thousands |

Mixed deployment target: **~500 concurrent workers** on a healthy Mac. Cloud is bounded only by spend.

## Design palette

- Honey yellow (`#FFC107`) — primary
- Burnt orange (`#FF6B1A`) — running / active
- Near-black (`#0A0A0A`) — surface
- Dark grey (`#1F1F1F`) — borders
- White / grey-400 — text
- Hexagonal motifs throughout — backgrounds, bot cards, loading states

## Project structure

```
hive/
├── apps/
│   ├── api/         Fastify control plane
│   ├── ui/          Next.js dashboard
│   └── dispatcher/  Job router (Redis → worker pools)
├── packages/
│   ├── db/          Prisma schema + client
│   └── shared/      Zod schemas, types, constants
├── workers/
│   ├── base/        Shared Python worker library
│   ├── browser/     Playwright fleet
│   ├── scraper/     httpx + Scrapy
│   ├── rpa_desktop/ pyautogui
│   ├── discord/     discord.py
│   ├── telegram/    python-telegram-bot
│   ├── trading/     ccxt (TS)
│   ├── monitor/     apscheduler
│   ├── mcp_host/    MCP SDK (TS)
│   ├── ci_agent/    Docker SDK
│   ├── task_runner/ arq
│   └── ai_agent/    Claude / GPT / Perplexity (TS)
├── infra/docker/    docker-compose.yml
├── scripts/         install/dev helpers
└── docs/            architecture, pools, ops
```

## Roadmap

- **Phase 1** — Control plane (API + UI + dispatcher) + `scraper` worker end-to-end. Bot CRUD, job dispatch, SSE log streaming.
- **Phase 2** — `ai_agent` + `browser` + `monitor` workers. AI Console tab in UI. Cost tracking.
- **Phase 3** — `trading` + `discord` + `telegram`. Real-time SSE everywhere.
- **Phase 4** — `mcp_host` + `rpa_desktop` + `ci_agent` + `task_runner`.
- **Phase 5** — Cloud deploy targets (Fly.io / Railway / AWS), horizontal scaling, multi-tenant.
- **Phase 6** — Go live: provision a real cloud environment, set production secrets, deploy via `deploy/fly/deploy-all.sh` or `terraform apply`, run `scripts/smoke-cloud.sh`, point DNS. See [docs/DEPLOY.md](docs/DEPLOY.md).

## License

Private. All rights reserved.
