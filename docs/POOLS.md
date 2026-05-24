# Worker Pools

| Pool | Stack | Purpose |
|---|---|---|
| browser | Python + Playwright | Headless browser fleets, testing, web RPA |
| scraper | Python + httpx/Scrapy | API scrapers, sportsbook lines, ESPN |
| rpa_desktop | Python + pyautogui | Desktop app automation |
| discord | Python + discord.py | Discord bots |
| telegram | Python + python-telegram-bot | Telegram bots |
| trading | TypeScript + ccxt | Market making, arbitrage, Crossbar |
| monitor | Python + apscheduler | Uptime, alerting, cron probes |
| mcp_host | TypeScript + MCP SDK | MCP server fleet |
| ci_agent | Python + Docker SDK | CI runners, build agents |
| task_runner | Python + arq | Generic distributed tasks |
| ai_agent | TypeScript + Anthropic/OpenAI/Perplexity | Claude / GPT / Perplexity orchestration |
