# 🐝 Hive — Getting Started in VS Code

You just unzipped Hive. Here's the fastest path to a running dev environment.

## 1. Open the workspace (not the folder)

```
File → Open Workspace from File... → hive.code-workspace
```

This gives you the multi-root layout: root, every app, every worker pool — each at the top level of the sidebar. Way better than digging through nested folders.

## 2. Install recommended extensions

VS Code will prompt you. Hit **Install All**. The important ones:

- **Claude Code** — Anthropic's coding agent (you already use this)
- **Prisma** — schema syntax + IntelliSense
- **Tailwind CSS IntelliSense** — class autocomplete
- **Python + Pylance** — for all 8 Python workers
- **ESLint + Prettier** — TypeScript formatting
- **Docker** — manage the Postgres/Redis containers from the sidebar
- **Error Lens** — inline error messages

## 3. Prerequisites (install on your Mac if missing)

```bash
# Node 20+ and pnpm
brew install node pnpm

# Python 3.11+
brew install python@3.11

# Docker Desktop
brew install --cask docker
# (launch Docker.app once so the daemon is running)
```

## 4. First-run setup (one command)

`Cmd+Shift+P` → **Tasks: Run Task** → **🔥 Full Setup (first run)**

That runs sequentially:
1. `make docker-up` — Postgres + Redis containers
2. `pnpm install` — all TypeScript deps
3. `make workers-install` — Python virtualenvs for each pool
4. `make db-migrate` — Prisma schema → Postgres

Or do it manually in the integrated terminal:
```bash
cp .env.example .env       # fill in API keys
make docker-up
pnpm install
make workers-install
make db-migrate
```

## 5. Fill in `.env`

At minimum for Phase 1:
- `ANTHROPIC_API_KEY` — for the `ai_agent` worker
- `OPENAI_API_KEY` — same
- `PERPLEXITY_API_KEY` — same


## 6. Run the control plane

**Option A — Run & Debug panel** (recommended):
- Click the Run & Debug icon in the sidebar (or `Cmd+Shift+D`)
- Select **🐝 Hive: Full Control Plane** from the dropdown
- Hit play. API, UI, and Dispatcher all start with breakpoint debugging.

**Option B — Terminal**:
```bash
pnpm dev
```

UI opens at http://localhost:3000, API at http://localhost:4000.

## 7. Run a worker (separate launch)

Run & Debug → pick any worker config:
- **Worker: Scraper (Python)**
- **Worker: Browser (Python)**
- **Worker: AI Agent (Node)**
- **Worker: Trading (Node)**

You can run several at once — each gets its own terminal pane.

## 8. Useful tasks (`Cmd+Shift+P` → Tasks: Run Task)

- 🐳 **Docker: Start / Stop** — toggle infrastructure
- 🗄️ **DB: Migrate** — after schema changes
- 🗄️ **DB: Studio** — Prisma GUI at http://localhost:5555
- 🔥 **Full Setup (first run)** — the all-in-one above

## What's where

| Sidebar entry | Purpose |
|---|---|
| 🐝 Hive (root) | Monorepo config, `.env`, Docker, scripts, docs |
| 📡 api | Fastify control plane |
| 🖥️ ui | Next.js dashboard (the bot-picker UI) |
| 🚦 dispatcher | Job router from Redis queue → worker pools |
| 📦 packages/db | Prisma schema + client |
| 📦 packages/shared | Zod schemas, types, pool constants |
| 🌐🕷️🤖💱📊💬✈️🔌🛠️⚙️📋 workers/* | The 11 worker pools |
| 🐍 worker: base | Shared Python lib (`hive_base`) |

## Current state (Phase 0)

Everything above is **scaffolded but not implemented**. Each app/worker has a placeholder `index.ts` or `main.py` that just prints a startup message. Database schema, types, Docker, Tailwind palette, hex grid background — all wired and ready.

## Phase 1 — what to build next

The scaffold is the chassis. Phase 1 puts an engine in it:

1. **API**: Bot CRUD, Job CRUD, BullMQ dispatch, SSE log streaming endpoint
2. **Dispatcher**: Pull from BullMQ → route to Redis pool queue
3. **Scraper worker**: Real Playwright/httpx implementation; ESPN scoreboard as first BotTemplate
4. **UI**: Dashboard, Bots list, Job detail with live log streaming, ⌘K command palette

Tell Claude "let's build Phase 1" when you're ready. The architecture is locked, so it's just filling in the implementations file by file.

## Troubleshooting

**Docker won't start**: Launch Docker Desktop manually first. The `make docker-up` task assumes the daemon is running.

**`pnpm install` fails**: Check Node version. `node --version` must be ≥ 20.


**Prisma client errors**: Run `pnpm db:generate` after pulling schema changes.

**Port conflicts**: Defaults are 3000 (UI), 4000 (API), 4100 (Dispatcher), 5432 (Postgres), 6379 (Redis). Change in `.env` if needed.
