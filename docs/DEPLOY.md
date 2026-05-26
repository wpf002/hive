# Deploying Hive

Three cloud targets are scaffolded under `deploy/`. Pick one; they're not
meant to run in parallel.

| Target  | When to pick it                                                    | Path                       |
|---------|--------------------------------------------------------------------|----------------------------|
| Fly.io  | Early users, cheapest, simplest. Tigris for S3, static KMS.        | [DEPLOY_FLY.md](DEPLOY_FLY.md) |
| AWS     | Production scale, real KMS, multi-AZ Postgres, IAM-shaped security | [DEPLOY_AWS.md](DEPLOY_AWS.md) |
| Railway | Teams already on Railway, managed PG/Redis, friendliest dashboard  | [DEPLOY_RAILWAY.md](DEPLOY_RAILWAY.md) |

## What every target shares

- **Shared Postgres + Redis**: every service in the stack reads/writes the
  same DB and Redis. They must be reachable from all worker hosts. Use TLS
  (`postgres://...sslmode=require`, `rediss://...`) for anything beyond dev.
- **HIVE_SECRETS_KEY**: 32 raw bytes (64 hex chars), shared across every
  service. Both the static KMS path and the v1 secret encryption use it as
  the master key.
- **Single dispatcher + scheduler**: these hold consumer-group state on
  `hive:dispatch` and a polling lock on the `Schedule` table. Don't scale
  past 1 — every cloud target&rsquo;s config pins them.
- **Workers self-declare region + zone** via `HIVE_WORKER_REGION` /
  `HIVE_WORKER_ZONE`. Pool affinity uses these labels — see
  [MULTIHOST.md](MULTIHOST.md).
- **`rpa_desktop` is never deployed to cloud**. Run that pool on a real
  desktop machine. The Fly deploy script explicitly skips it; ECS and
  Railway scaffolds simply don&rsquo;t include it.

## Recommended path

1. **Fly staging** to validate the stack end-to-end without committing to
   AWS-level config complexity. Cheap, fast to spin up.
2. **Fly → AWS** once you need multi-AZ Postgres, real KMS, or fleet sizes
   that out-grow Fly's per-machine ceilings.
3. **Railway** if your team is already standardized there.

## Post-deploy smoke

After any cloud deploy:

```bash
API_BASE=https://hive-api.fly.dev \
AUTH_TOKEN=<your API_AUTH_TOKEN> \
./scripts/smoke-cloud.sh
```

Health-checks every service, creates a Cron Heartbeat bot, runs it, waits
for it to finish, then cleans up. Designed to catch the &ldquo;deployed but the
worker can't reach Redis&rdquo; failure mode.

## Staging recipes

- Fly: deploy each app with a `-staging` suffix (e.g. `hive-api-staging`),
  set `HIVE_ENV_LABEL=staging` on its secrets, and point its
  `DATABASE_URL` at a separate Fly Postgres instance.
- AWS: `terraform apply -var-file=staging.tfvars` provisions a parallel
  stack with `env_label=staging`. Use `terraform workspace new staging` so
  the state files stay separate from prod.
- Railway: create a `staging` environment in the Railway UI; per-environment
  variables override the production set automatically.

## Environment label

Every target sets `HIVE_ENV_LABEL` (e.g. `production`, `staging`). The UI
renders this as a colored pill in the top bar so an operator can tell at a
glance which env they're driving.
