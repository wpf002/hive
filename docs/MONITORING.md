# Monitoring

Phase 6 ships **external** monitoring (something outside Hive watching Hive).
Internal self-monitoring (Hive's own monitor pool watching the fleet) is Phase 7.

## What watches what

| Layer | Tool | What it checks |
|-------|------|----------------|
| External uptime | UptimeRobot / Better Stack | UI + API reachable over HTTPS |
| Built-in health | `/healthz` per service | dependencies (DB, Redis, lag, heartbeat) |
| Status page | `https://hive.<yourdomain>/status` | per-service + per-pool grid, no auth |
| Logs | `flyctl logs` (+ optional drain) | per-service stdout |

## 1. External health checks (operator sets this up manually)

We cannot script third-party SaaS configuration — do this in the UptimeRobot or
Better Stack dashboard.

Create two **HTTPS GET** monitors, 1-minute interval:

- `https://hive.<yourdomain>/login` — UI alive (expect HTTP 200)
- `https://api.hive.<yourdomain>/healthz` — API alive (expect HTTP 200; the
  endpoint returns **503** when a dependency is down, which the monitor treats
  as a failure — exactly what we want)

Alert channels:
- Email to the operator (required)
- Optionally a Slack/Discord webhook

After creating them, **trigger a test alert** from the dashboard and confirm it
arrives (runbook gate 7).

## 2. Built-in `/healthz` (already deployed)

Every service exposes `/healthz` returning:

```json
{
  "status": "ok",            // or "degraded"
  "service": "api",
  "version": "<sha or 0.1.0>",
  "region": "fly-ord",
  "uptime_seconds": 1234,
  "checks": { "...": { "ok": true } }
}
```

- HTTP **200** when healthy, **503** when degraded (any check fails).
- `ETag` + `Cache-Control: max-age=5` — repeated polls within 5s get a `304`
  and don't re-hit Postgres/Redis.

Per-service checks:

| Service | Checks |
|---------|--------|
| api | postgres reachable, redis reachable |
| dispatcher | redis reachable, `hive:dispatch` consumer lag < 1000 |
| scheduler | database reachable, schedules loaded (if any active) |
| session-sweeper | last successful sweep within 2× the interval |
| workers | heartbeat accepted in last 30s, redis reachable |

Workers only serve `/healthz` when `HIVE_WORKER_HEALTHZ_PORT` is set (they're
stream consumers by default). The `/status` page derives worker health from the
**heartbeat table** instead, so you don't need to expose worker HTTP ports just
to see pool health.

To test the 503 path in staging: pause Redis briefly
(`flyctl redis ... ` suspend, or block the port) and confirm `/healthz` flips to
503 + `status: "degraded"`, then recovers.

## 3. Status page

`https://hive.<yourdomain>/status` (no auth) shows:

- Control-plane service grid (api always; dispatcher/scheduler/sweeper show
  their reported status if `HIVE_DISPATCHER_URL` / `HIVE_SCHEDULER_URL` /
  `HIVE_SWEEPER_URL` are set on the API, else `unknown`)
- Worker-pool grid: green = a worker checked in <30s ago, yellow = dropped off
  in the last 2 min, grey = idle/no workers reporting
- Incidents in the last 24h (operator records these as `AuditLog` rows with
  `action='system.incident'`)
- Last deploy SHA + timestamp (`HIVE_GIT_SHA` / `HIVE_DEPLOYED_AT`)

Server-rendered, cached 30s.

### Recording an incident

There's no incident UI yet — insert an AuditLog row directly:

```sql
INSERT INTO "AuditLog" (id, action, payload, "createdAt")
VALUES (gen_random_uuid()::text, 'system.incident',
        '{"message":"Scraper pool degraded — Upstash connection limit"}', now());
```

## Logs

See `docs/PRODUCTION.md` → "Log retention + access".
