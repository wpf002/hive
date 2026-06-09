# Worker Pools

| Pool | Stack | Purpose |
|---|---|---|
| browser | Python + Playwright | Headless browser fleets, end-to-end testing, web automation |
| scraper | Python + httpx/Scrapy | API scrapers, sportsbook lines, ESPN |
| trading | TypeScript + ccxt | Market making, arbitrage, Crossbar |
| monitor | Python + apscheduler | Uptime, alerting, cron probes |
| mcp_host | TypeScript + MCP SDK | MCP server fleet — see [MCP.md](./MCP.md) |
| ci_agent | Python + Docker SDK | CI runners, build agents |
| task_runner | Python (subprocess) | Generic distributed tasks (Python, shell, webhook receivers) |
| ai_agent | TypeScript + Anthropic/OpenAI/Perplexity | Claude / GPT / Perplexity orchestration |

## ci_agent

Requires `/var/run/docker.sock` reachable by the worker user. On Linux:

```
sudo chgrp docker /var/run/docker.sock
sudo usermod -aG docker $USER  # then log out / back in
```

On macOS, Docker Desktop is enough — no extra dance required.

Templates: `GitHub Repo Test Runner`, `Docker Image Builder`, `Shell Command Runner`.

`timeoutSeconds` is enforced by `container.wait(timeout=…)` plus an outer asyncio.wait_for; on timeout the container is force-killed and removed so no zombies accumulate.

## task_runner

The pool name is historical (originally targeted arq). The current implementation does **not** use arq — handlers run as subprocesses on the worker host with a wall-clock timeout. Memory caps via `resource.setrlimit(RLIMIT_AS, …)` only take effect on Linux; on macOS the limit is silently ignored.

Templates: `Python Script Runner`, `Shell Command Runner (Native)`, `Generic Webhook Receiver Echo`.

**Security tradeoff for `Shell Command Runner (Native)`**: this runs the user-supplied command directly on the worker host, with no container isolation. Treat the template like RCE. Use the ci_agent `Shell Command Runner` (which runs inside Docker) unless you specifically need host access (and trust the operators).


**Singleton pool — only one job runs at a time across the entire host.** The worker declares `singleton=True` in its heartbeat metadata; the API checks the live worker table on every `POST /api/bots/:id/run` and refuses parallel dispatch with `429 pool_busy` (plus `Retry-After: 30` and a `retryAfterMs` hint). This is intentionally conservative — the mouse, keyboard, and screen are shared global resources.


### OS prerequisites

The worker fails loudly at startup if any of these is missing — better to know during `mprocs` than after dispatching a job.

| Requirement | macOS | Linux | Windows |
|---|---|---|---|
| Tesseract binary (OCR) | `brew install tesseract` | `sudo apt-get install -y tesseract-ocr` | https://github.com/UB-Mannheim/tesseract/wiki |

### Security implications


### mprocs

