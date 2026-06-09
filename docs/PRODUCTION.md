# Production (Fly.io)

Living operator doc for the deployed Hive. Pairs with `GO_LIVE_RUNBOOK.md` (the
launch-day checklist) and `MONITORING.md` (how we watch it).

## Architecture (Fly-specific)

```
                    ┌─────────────────────────────────────────────┐
   hive.<domain> ──▶│ hive-ui (Next.js)                            │
                    └─────────────────────────────────────────────┘
api.hive.<domain> ─▶┌─────────────────────────────────────────────┐
                    │ hive-api (Fastify) ── /healthz /status        │
                    └───────┬──────────────────────┬───────────────┘
                            │                      │
              ┌─────────────▼───┐      ┌───────────▼────────────┐
              │ hive-pg          │      │ hive-redis (Upstash)   │
              │ (Fly Postgres)   │      │ streams + dedupe       │
              └──────────────────┘      └────────────────────────┘
   control plane: hive-dispatcher, hive-scheduler, hive-session-sweeper
   workers (scale 0..N): hive-worker-{scraper,monitor,ai-agent,trading,
   artifacts: Tigris bucket  hive-artifacts-prod  (S3-compatible)
```

  Run it on a real machine with `pnpm workers:dev`.
- Workers reach Postgres only via the API; only control-plane apps get a direct
  `DATABASE_URL`.

## Common operational commands

```bash
flyctl logs -a hive-api                      # tail one service
flyctl ssh console -a hive-api               # shell into a machine
flyctl ssh console -a hive-api -C "pnpm --filter @hive/api seed"   # re-seed (idempotent)
flyctl scale count 2 -a hive-worker-scraper  # scale a worker pool
flyctl status -a hive-api                    # machine + health state
flyctl secrets list -a hive-api              # secret names (not values)
flyctl postgres connect -a hive-pg           # psql session
```

## Scaling guidance

- **Workers**: `flyctl scale count <n> -a hive-worker-<pool>`. Pools are
  independent; scale the busy ones. Cold deploys of the browser pool (~500MB
  image) take 2–3 min — scale during low traffic.
- **Postgres**: the lowest tier is single-region. Upgrade the VM
  (`flyctl machine update`) before adding read load; multi-region requires a
  Postgres tier upgrade (documented, not enabled in Phase 6).
- **Adding a region**: deploy workers to the new region with
  `HIVE_WORKER_REGION=fly-<region>` and set bot/template affinity to route work
  there (Phase 5b affinity).

## Known production-only quirks

- **Fly cold starts**: control-plane apps run with `min_machines_running=1` so
  they stay warm. Workers may scale to zero — the dispatcher's unroutable sweep
  tolerates a 60s scale-from-zero window (`HIVE_UNROUTABLE_TIMEOUT_S`).
- **Upstash connection limits**: the browser pool (4 concurrent + many
  short-lived clients) can exhaust the free Upstash tier's connection cap. If
  you see Redis connection errors there, upgrade the Upstash tier.
- **Tigris storage growth**: screenshots accumulate. Watch bucket size; a
  retention policy lands in Phase 7. For now, prune manually if needed.
- **Resend domain verification**: SPF/DKIM/DMARC DNS records take 5–15 min to
  propagate. Mail won't send until the domain is "Verified" in Resend.
- **Secrets trigger redeploys**: `flyctl secrets set` redeploys the app.
  `set-secrets.sh` batches all of a service's secrets into one `--stage` call so
  you get one redeploy, not one per secret.

## Secret rotation

- `HIVE_SECRETS_KEY`: rotate **quarterly**. This re-wraps DEKs — never just swap
  the value. Procedure:
  1. Generate a new key, set it as the new static KEK, move the old one into
     `HIVE_KMS_STATIC_RETIRED_KEYS` (see `docs/SECRETS.md`).
  2. Run `pnpm --filter @hive/api kms:rotate` to re-wrap envelopes.
  3. Once the sweep completes, drop the retired key.
- `API_AUTH_TOKEN` / `WORKER_AUTH_TOKEN`: rotate by setting the new value on the
  API + all workers, then redeploy. Brief overlap is fine.
- Store all values in the password manager; never commit them.

## Incident response

- **Where are the logs?** `flyctl logs -a <app>`. Retention on Fly is short
  (a few days).
- **Long-term logs**: configure a log drain to Logtail or Axiom —
  `flyctl logs` has built-in drain support. This is config-only (no code):
  follow the provider's Fly integration guide and add the drain token. (Not
  enabled by default in Phase 6.)
- **Roll back a service**: `flyctl deploy -a <app> --image <previous-image-ref>`
  (find prior refs with `flyctl releases -a <app>`).
- **Restore the database**: see Backups below.

## Backups

- Fly Postgres takes **automatic daily snapshots, 7-day retention**.
- Manual snapshot: `flyctl postgres backup create -a hive-pg`.
- List snapshots: `flyctl postgres backup list -a hive-pg`.
- Restore: `flyctl postgres backup restore <backup-id> -a hive-pg` (or restore
  into a fresh app and re-point `DATABASE_URL`). Test a restore before you need
  it.
- **Recommended**: a weekly off-platform backup. Either a local cron running
  `flyctl postgres backup create`, or a Hive Cron Heartbeat-style bot that calls
  a backup trigger. **Not implemented in Phase 6 — documented for the operator
  to set up.**
