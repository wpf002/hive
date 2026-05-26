# Hive on Railway

Railway is the "middle option" between Fly (lightweight) and AWS (production-
grade). The control plane is friendlier than AWS; the cost profile sits
between the two.

This directory ships a `railway.json` per service. Railway reads it on deploy
so the build/start commands and health checks come from version control
rather than the web UI.

Reuse the same Dockerfiles Fly uses (`deploy/fly/Dockerfile.ts-app` and
`deploy/fly/Dockerfile.python-worker`) — Railway supports `dockerfilePath`.

## Files

- `railway.api.json` — API service
- `railway.dispatcher.json` — Dispatcher
- `railway.scheduler.json` — Scheduler
- `railway.session-sweeper.json` — Session sweeper
- `railway.ui.json` — UI
- `railway.worker-<pool>.json` — Per-pool worker

## See also

- `/docs/DEPLOY_RAILWAY.md` for the full walkthrough.
