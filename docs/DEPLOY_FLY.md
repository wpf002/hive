# Deploying Hive to Fly.io

Fly is the recommended starter cloud target — cheap, fast, and the deploy
flow is `flyctl deploy` per service. This guide is the walk-through; the
shell script `deploy/fly/deploy-all.sh` is the &ldquo;do all the things&rdquo; companion.

## What gets deployed

| Service               | Type        | Fly app name           | Scale  |
|-----------------------|-------------|------------------------|--------|
| apps/api              | HTTP (TS)   | `hive-api`             | 1      |
| apps/dispatcher       | HTTP (TS)   | `hive-dispatcher`      | 1 only |
| apps/scheduler        | HTTP (TS)   | `hive-scheduler`       | 1 only |
| apps/session-sweeper  | HTTP (TS)   | `hive-session-sweeper` | 1      |
| apps/ui               | HTTP (TS)   | `hive-ui`              | 0..N   |
| workers/scraper       | Worker (Py) | `hive-worker-scraper`  | 0..N   |
| workers/monitor       | Worker (Py) | `hive-worker-monitor`  | 0..N   |
| workers/browser       | Worker (Py) | `hive-worker-browser`  | 0..N   |
| workers/ai_agent      | Worker (TS) | `hive-worker-ai-agent` | 0..N   |
| workers/trading       | Worker (TS) | `hive-worker-trading`  | 0..N   |
| workers/mcp_host      | Worker (TS) | `hive-worker-mcp-host` | 0..N   |
| workers/ci_agent      | Worker (Py) | `hive-worker-ci-agent` | 0..N   |
| workers/task_runner   | Worker (Py) | `hive-worker-task-runner` | 0..N |

Run that pool on a real machine (laptop, NUC, dedicated host).

## Backing services

Fly itself doesn&rsquo;t provide Postgres or Redis with the same one-click ergonomics
as RDS / ElastiCache, so we lean on:

- **Postgres**: Fly Postgres (`flyctl postgres create`) for dev/staging,
  Supabase for production (better point-in-time recovery + dashboards).
- **Redis**: Upstash Redis (free tier covers dev; bump to paid for prod).
  Upstash ships TLS by default — use the `rediss://` URL.
- **S3-compatible artifacts**: Tigris (`flyctl storage create`) is built into
  Fly and the cheapest path. Backblaze B2 is a strong alternative if you
  want a separate-vendor blast-radius story.
- **KMS**: Fly has no managed KMS. Use the static-key provider with
  `HIVE_KMS_PROVIDER=static` and treat `HIVE_SECRETS_KEY` as the KEK.
  Rotation is still supported via the envelope flow (see SECRETS.md).
  When you outgrow this, mirror the deployment to AWS (DEPLOY_AWS.md) for
  real KMS.

## One-time setup

```bash
# Authenticate.
flyctl auth login

# Create each app. Names are baked into the .fly.toml files so use these
# exactly:
for svc in hive-api hive-dispatcher hive-scheduler hive-session-sweeper hive-ui \
           hive-worker-scraper hive-worker-monitor hive-worker-browser \
           hive-worker-ai-agent hive-worker-trading hive-worker-mcp-host \
           hive-worker-ci-agent hive-worker-task-runner \
  flyctl apps create "$svc" --org personal
done

# Provision backing services.
flyctl postgres create --name hive-postgres --region ord --vm-size shared-cpu-1x --volume-size 10
# Note the DATABASE_URL printed at the end.

# Tigris bucket (or Backblaze B2 — set HIVE_ARTIFACT_S3_ENDPOINT accordingly).
flyctl storage create hive-artifacts

# Upstash Redis: provision at https://upstash.com and grab the rediss:// URL.

# Set the shared secrets on the API app. Generate fresh values for anything
# left blank in your local .env.
SHARED_SECRETS=(
  "DATABASE_URL=postgres://..."
  "REDIS_URL=rediss://..."
  "API_AUTH_TOKEN=$(openssl rand -hex 32)"
  "WORKER_AUTH_TOKEN=$(openssl rand -hex 32)"
  "JWT_SECRET=$(openssl rand -hex 32)"
  "SESSION_SECRET=$(openssl rand -hex 32)"
  "HIVE_SECRETS_KEY=$(openssl rand -hex 32)"
  "ADMIN_EMAIL=you@example.com"
  "ADMIN_PASSWORD=$(openssl rand -base64 16)"
)
flyctl secrets set --app hive-api "${SHARED_SECRETS[@]}"
flyctl secrets set --app hive-dispatcher "${SHARED_SECRETS[@]:0:7}"  # no admin / no auth tokens needed
flyctl secrets set --app hive-scheduler "${SHARED_SECRETS[@]:0:7}"
flyctl secrets set --app hive-session-sweeper "${SHARED_SECRETS[@]:0:7}"
flyctl secrets set --app hive-ui  DATABASE_URL=... API_BASE_URL=https://hive-api.fly.dev
# … repeat for every worker app with the worker-specific token set.

# Artifact storage (Tigris): same vars on every service that uploads.
flyctl secrets set --app hive-api \
  HIVE_STORAGE_PROVIDER=s3 \
  HIVE_ARTIFACT_S3_BUCKET=hive-artifacts \
  HIVE_ARTIFACT_S3_ENDPOINT=https://fly.storage.tigris.dev \
  HIVE_ARTIFACT_S3_REGION=auto \
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
```

## Deploying

```bash
# All services in dependency order.
./deploy/fly/deploy-all.sh

# Or one at a time.
./deploy/fly/deploy-all.sh api
./deploy/fly/deploy-all.sh worker-scraper

# Dry run — print what would happen.
./deploy/fly/deploy-all.sh --dry-run
```

The script:

1. Runs the Prisma migration against the production DB *before* the API
   redeploy (reads `DATABASE_URL` from the `hive-api` secrets via `flyctl`).
2. Deploys each service in order, using `--remote-only` so a slow laptop
   doesn&rsquo;t become the build bottleneck.

## Scaling

```bash
# 3 scraper workers, each in ord; mirrors via region tags.
flyctl scale count 3 --app hive-worker-scraper --region ord

# A second scraper deployment in eu-west, declared via HIVE_WORKER_REGION:
flyctl secrets set --app hive-worker-scraper-eu HIVE_WORKER_REGION=eu-west HIVE_WORKER_ZONE=ams
```

Workers self-declare region+zone via env, not Fly&rsquo;s primary_region — that&rsquo;s
deliberate: pool affinity routes by what *the worker says it is*, not where
the Fly machine landed. Set the env to match the Fly region for clarity.

## Updates

`flyctl deploy --config <fly.toml> --remote-only` rebuilds the image and
rolls it out one machine at a time. The API has health checks on `/healthz`
so a broken build doesn&rsquo;t replace the running revision.

## Troubleshooting

- **Dispatcher delivered the same job to two consumers**: you scaled the
  dispatcher beyond 1. The Fly config sets `min_machines_running = 1` and
  the lock comment in the file warns against this — `flyctl scale count 1`
  to recover.
- **&ldquo;NOGROUP&rdquo; on dispatcher start**: someone deleted `hive:dispatch` in Redis.
  The dispatcher re-creates the group on startup; restart the app.
- **Unroutable jobs piling up**: the bot&rsquo;s affinity targets a region/zone
  combo with no online worker. See `/docs/MULTIHOST.md`.
- **Tigris vs AWS S3 presigned URL signatures**: Tigris supports SigV4 the
  same as AWS, so the existing `@aws-sdk/s3-request-presigner` flow works.
  Backblaze B2 has a different SigV4 dialect — if you pick B2, test the
  presigned-URL flow end-to-end before going live.
