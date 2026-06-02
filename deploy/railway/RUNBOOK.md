# Railway deploy runbook (full fleet)

Step-by-step to put **every** Hive service on Railway. Reflects the corrected
per-service configs in this directory. Railway has no managed object storage or
KMS, so you bring an S3-compatible bucket (Backblaze B2 / Cloudflare R2) and use
the static KMS provider.

> **Cost note:** this is ~15 always-on services + Postgres + Redis. The
> dispatcher and workers must stay up (Railway's free tier sleeps idle
> services, which strands jobs in `queued`). Use a paid plan.

## Service inventory (16 configs in this dir)

Control plane (TS, `Dockerfile.ts-app`): **api, ui, dispatcher, scheduler,
session-sweeper**
TS workers: **worker-ai-agent, worker-mcp-host, worker-trading**
Python workers (`Dockerfile.python-worker`): **worker-scraper, worker-ci-agent,
worker-discord, worker-monitor, worker-task-runner, worker-telegram**
Browser worker (own `workers/browser/Dockerfile`): **worker-browser**
**worker-rpa-desktop** — config exists for completeness but **do NOT deploy it**:
it needs a real desktop/display (pyautogui), which a Railway container can't
provide.

## 0. Object storage (do this first)

Pick one; both are S3-compatible and cheap.

**Backblaze B2**
1. Create a B2 account → *Buckets* → *Create a Bucket* (private). Note the name.
2. *App Keys* → *Add a New Application Key*, scoped to that bucket. Save the
   `keyID` and `applicationKey`.
3. Note the bucket's **S3 endpoint** (e.g. `https://s3.us-west-004.backblazeb2.com`)
   and **region** (e.g. `us-west-004`).

**Cloudflare R2**
1. R2 → *Create bucket* (note the name).
2. *Manage R2 API Tokens* → create a token with Object R/W on that bucket.
   Save Access Key ID + Secret.
3. Endpoint is `https://<accountid>.r2.cloudflarestorage.com`; region `auto`.

Map to env vars:
```
HIVE_STORAGE_PROVIDER=s3
HIVE_ARTIFACT_S3_BUCKET=<bucket>
HIVE_ARTIFACT_S3_ENDPOINT=<s3 endpoint URL>
HIVE_ARTIFACT_S3_REGION=<region>
AWS_ACCESS_KEY_ID=<keyID / access key>
AWS_SECRET_ACCESS_KEY=<applicationKey / secret>
```
(After go-live, run the screenshot bot and confirm the artifact download works —
B2's presigned-URL host differs from AWS, so verify end-to-end.)

## 1. Project + managed data

```bash
railway login
railway init --name hive          # creates the project
railway add --database postgres   # provides DATABASE_URL
railway add --database redis      # provides REDIS_URL
```

## 2. Generate the shared secrets (store in a password manager)

```bash
bash scripts/generate-production-secrets.sh   # prints; never writes to disk
```
You need: `HIVE_SECRETS_KEY` (64 hex), `API_AUTH_TOKEN`, `WORKER_AUTH_TOKEN`,
`JWT_SECRET`, `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.

## 3. Create each service and point it at its config

For every service, in the Railway dashboard set **Settings → Config-as-code →
Path** to `deploy/railway/railway.<service>.json` (this is the one step the CLI
can't do). Or create via CLI then set the path in the UI:

```bash
for svc in api ui dispatcher scheduler session-sweeper \
           worker-ai-agent worker-mcp-host worker-trading \
           worker-scraper worker-ci-agent worker-discord worker-monitor \
           worker-task-runner worker-telegram worker-browser; do
  railway add --service "$svc" --repo wpf002/hive
done
```

## 4. Environment variables

Set on **every** service (Railway can share these via a shared variable group;
reference Postgres/Redis with `${{Postgres.DATABASE_URL}}` /
`${{Redis.REDIS_URL}}`):

```
DATABASE_URL, REDIS_URL,
HIVE_SECRETS_KEY, API_AUTH_TOKEN, WORKER_AUTH_TOKEN,
HIVE_KMS_PROVIDER=static,
HIVE_STORAGE_PROVIDER=s3, HIVE_ARTIFACT_S3_BUCKET, HIVE_ARTIFACT_S3_ENDPOINT,
HIVE_ARTIFACT_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
```

Per-service extras:
| Service | Also set |
|---|---|
| api | `JWT_SECRET`, `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SECURE_COOKIES=true`, `HIVE_PUBLIC_APP_URL=https://<ui-domain>`, `HIVE_EMAIL_PROVIDER` (+ `RESEND_API_KEY`, `RESEND_FROM_EMAIL` if used) |
| ui | `NEXT_PUBLIC_API_BASE=https://<api-domain>` *(build-time — set before deploy)* |
| worker-ai-agent | `ANTHROPIC_API_KEY` (+ `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`) |
| worker-scraper | `ODDS_API_KEY` |
| worker-discord | `DISCORD_BOT_TOKEN` |
| worker-telegram | `TELEGRAM_BOT_TOKEN` |
| worker-trading | exchange keys; keep `TRADING_LIVE_ENABLED=false` |

Ports: the API now honors Railway's injected `$PORT`; the UI binds `$PORT` too
(`next start -p ${PORT:-3001}`). No manual port config needed.

## 5. Domains, migrate, deploy

```bash
railway domain --service api      # public API URL
railway domain --service ui       # public UI URL  → set NEXT_PUBLIC_API_BASE to the API URL, then redeploy ui
```

Run migrations + seed once (against the api service env):
```bash
railway run --service api -- pnpm --filter @hive/db exec prisma migrate deploy
railway run --service api -- pnpm --filter @hive/api seed        # templates + admin
# optional demo data:
railway run --service api -- pnpm --filter @hive/api seed:demo
```

Deploy each service:
```bash
for svc in api ui dispatcher scheduler session-sweeper \
           worker-ai-agent worker-mcp-host worker-trading \
           worker-scraper worker-ci-agent worker-discord worker-monitor \
           worker-task-runner worker-telegram worker-browser; do
  railway up --service "$svc" --detach
done
```

## 6. Smoke test

- `https://<api-domain>/healthz` → `200`
- Log into the UI as `ADMIN_EMAIL`.
- Run the **Cron Heartbeat** bot → job reaches `succeeded` (proves dispatcher +
  a worker + Redis + Postgres).
- Run **Full Page Screenshot** → artifact uploads and downloads (proves S3).
