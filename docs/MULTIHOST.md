# Multi-host worker fleets (Phase 5b)

Hive workers can live on multiple hosts and self-declare their *region* and
*zone*. The dispatcher uses those declarations to route jobs to a worker that
matches a bot&rsquo;s **affinity** — useful when:

- A bot needs a specific network (VPN, residential IP, prod-only egress).
- A trading bot must run from a specific colo / cloud region for latency.
- A `rpa_desktop` worker needs the physical machine in front of the user.
- You want zero-downtime moves between regions during a migration.

Pre-5b single-host setups keep working with **no env changes** — every worker
defaults to `region='local'`, `zone='default'`, and every bot defaults to no
affinity → jobs land on `hive:pool:<pool>:any:any`, which all workers consume.

## Stream layout

```
hive:pool:<pool>:any:any           — no-affinity jobs (default landing)
hive:pool:<pool>:<region>:any      — region-only affinity
hive:pool:<pool>:<region>:<zone>   — specific region + zone
```

A worker in `(region, zone)` subscribes to **all three streams it could legally
consume** with per-stream consumer groups:

```
hive:pool:<pool>:workers:any:any
hive:pool:<pool>:workers:<region>:any
hive:pool:<pool>:workers:<region>:<zone>
```

So a worker in (`us-east`, `colo-1`) consumes:

- `hive:pool:browser:any:any`         (no-affinity jobs)
- `hive:pool:browser:us-east:any`     (region-only affinity jobs)
- `hive:pool:browser:us-east:colo-1`  (specific-zone affinity jobs)

A worker in (`local`, `default`) only consumes `hive:pool:<pool>:any:any` —
because its declared location isn't `any`, so it&rsquo;s ineligible for jobs that
*explicitly* target some other region.

## Setting up a remote worker

### Environment variables

Set on the *worker host* (the API/Postgres/Redis stay on the primary host):

```bash
# Required — point at the primary host's Postgres + Redis.
DATABASE_URL=postgresql://hive:hive@primary-host:5433/hive
REDIS_URL=redis://primary-host:6380

# Required — workers post heartbeats here and POST artifacts here.
API_BASE_URL=http://primary-host:4000
WORKER_AUTH_TOKEN=<same value as on the API host>

# Required — shared secret + KEK across the fleet so workers can decrypt
# bot configs delivered over the dispatch stream.
HIVE_SECRETS_KEY=<same value as on the API host>

# Phase 5b — worker self-declared location. Anything goes; common conventions:
#   region = cloud region or geographic label (us-east, eu-west, on-prem, …)
#   zone   = availability zone, rack, or machine identifier
HIVE_WORKER_REGION=us-east
HIVE_WORKER_ZONE=colo-1
```

### Network requirements

The remote worker host needs **TCP access** to:

- Postgres on the API host (port `5433` in the default docker-compose).
- Redis on the API host (port `6380`).
- The API HTTP port (`4000`) for heartbeats + artifact uploads.

For development across a NAT, an SSH tunnel works:

```bash
# Run on the worker host. Forwards remote 5433/6380/4000 to the API host.
ssh -L 5433:localhost:5433 \
    -L 6380:localhost:6380 \
    -L 4000:localhost:4000 \
    user@api-host
```

In a cloud setup, instead lock the security groups to the worker subnets and
turn on TLS (Upstash Redis ships with TLS by default; RDS Postgres needs
`sslmode=require` in the connection string).

### Starting the worker

Workers run exactly as before; the new env vars are read at startup:

```bash
# TypeScript worker
pnpm --filter @hive/worker-mcp-host dev

# Python worker
HIVE_WORKER_REGION=us-east HIVE_WORKER_ZONE=colo-1 \
  workers/base/.venv/bin/python -m hive_scraper
```

The worker&rsquo;s ID becomes `${pool}-${region}-${zone}-${hostname}-${shortId}` so
it&rsquo;s obvious in `/workers` which fleet member is which.

## Bot affinity

Two places can declare placement preferences:

- **Template-level** (`BotTemplate.affinity`): default for every bot derived
  from this template. Set in the template seed where applicable.
- **Bot-level** (`Bot.affinityOverride`): wins when set; null = inherit
  template default. Edit on the bot detail page in the UI.

Both fields use the same shape:

```json
{ "region": "us-east", "zone": "colo-1" }
```

Either field may be omitted; for example `{ "region": "us-east" }` routes to
the region-only stream (any zone in that region picks the job up).

## Unroutable jobs

If a bot&rsquo;s effective affinity matches **no online worker** when its job is
queued, the dispatcher waits 60s (set via `HIVE_UNROUTABLE_TIMEOUT_S`) and
then marks the job `status='unroutable'` with a descriptive error.

The `/workers` page surfaces unroutable counts at the top with a link to the
filtered jobs list. To fix:

1. Spin up a worker that satisfies the affinity, OR
2. Edit the bot&rsquo;s `affinityOverride` to widen the placement, OR
3. Requeue the job (`POST /api/jobs/:id/requeue`) once a worker is online.

## Local multi-host simulation

The repo includes a docker-compose **profile** that spins up a second
containerized scraper worker in a different zone so you can exercise the
multi-host routing without a second physical machine:

```bash
# Bring up postgres + redis + minio + the in-zone test worker.
docker compose -f infra/docker/docker-compose.yml --profile worker-fleet-test up -d
```

Verify both workers appear in `/workers` under different region/zone groups.
Create a bot with `affinityOverride={ "region": "eu-west", "zone": "test1" }`
and trigger it — only the in-zone test worker should pick it up.

Tear it down with:

```bash
docker compose -f infra/docker/docker-compose.yml --profile worker-fleet-test down
```

## Known friction points

- **Scale from zero**: if you queue a bot with strict affinity *before*
  starting any worker that matches, expect a 60s wait for the unroutable
  status to land. Either pre-start the worker or set `HIVE_UNROUTABLE_TIMEOUT_S`
  higher (e.g., 300 for a 5-minute window).
- **Shared Redis is the bus**: every worker host needs access to the same
  Redis. Use TLS in production. Workers that lose Redis exit and restart;
  in-flight jobs are marked failed via the worker&rsquo;s shutdown hook so the
  UI doesn&rsquo;t hang on &ldquo;running&rdquo; entries forever.
- **`rpa_desktop` is host-only**: the pool depends on a physical mouse/keyboard.
  Run one rpa_desktop worker per machine and declare its location accurately;
  the cloud deploy scripts explicitly skip this pool.
