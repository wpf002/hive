# Changelog

All notable changes to Hive are documented here.

## [Unreleased]

### Security
- **Fixed a privilege escalation that gave any logged-in non-admin arbitrary
  code execution on a worker host.** `POST /api/schedules` required only
  authentication, while `POST /api/bots/:id/run` required `admin`. Since the
  scheduler triggers runs using `API_AUTH_TOKEN` — which the API treats as
  admin-equivalent — a user could not press "run" but could install a cron that
  pressed it for them, with no admin in the loop. Combined with templates like
  "Shell Command Runner (Native)", which runs uncontained on the worker host
  with `DATABASE_URL`, `REDIS_URL` and `WORKER_AUTH_TOKEN` in its environment,
  that was full compromise. All schedule mutations are now admin-only.
- Editing a bot's config now disables its schedules. Scheduling a bot authorizes
  the config that existed at that moment; without this, an owner could swap the
  command out from under an admin's approval.
- `POST /api/onboarding` wrote Schedule rows directly, bypassing the route
  guard. Starter packs created by non-admins are now dormant until an admin
  enables them, and the response says so.

### Added
- Swarm layer: missions, blackboard, coordinator and the proposal approval gate.
  See `docs/SWARM.md`.

## [1.0.0] - 2026-06-02

First stable release. Hive is feature-complete across all 11 worker pools
ci_agent, task_runner, ai_agent), deployed to Fly.io, with a control plane
(API + UI + dispatcher + scheduler + session-sweeper), field-level secret
encryption (envelope/KMS), artifacts, scheduling, and a public status page.

### Security
- Auth is carried solely by a first-party HttpOnly session cookie; removed the
  admin-equivalent `NEXT_PUBLIC_API_TOKEN` that was being embedded in the
  browser bundle.
- CORS pinned to an allowlist (`HIVE_PUBLIC_APP_URL` + `HIVE_CORS_ORIGINS`)
  instead of reflecting any origin.
- Constant-time comparison for static API/worker tokens.
- Login spends bcrypt time even for unknown users (no email enumeration).
- Redis-backed rate limiting on login and password-reset endpoints.
- SSE auth no longer accepts a `?token=` query param (header only).
- Monitor worker SSRF guard: refuses URLs resolving to private/loopback/
  link-local addresses (incl. the cloud-metadata endpoint) unless
  `HIVE_MONITOR_ALLOW_INTERNAL=true`.

### Authorization
- Job execution is admin-only: running bots, creating/editing/deleting
  schedules, and cancelling jobs require the `admin` role. UI hides controls
  they can't use.
- Bots themselves are owner-scoped rather than admin-only — a bot is a stored
  config and nothing runs until something triggers it, and multi-tenancy needs
  users to own their own. The boundary is the trigger, not the record.

### Testing
- Added a test suite (Node's built-in runner via tsx, no new deps): 27 unit
  tests (crypto round-trip, CORS allowlist, password/enumeration guard,
  secret encrypt/decrypt/mask), 5 DB-backed integration tests for the admin
  authorization boundary (auto-skip without a database), and 5 Python tests
  for the SSRF guard. `pnpm verify` (and the pre-push hook) now runs the unit
  tests alongside typecheck + lint.

### Developer experience
- `pnpm --filter @hive/api seed:demo` populates every UI page with realistic
  sample data (idempotent; `-- --reset` to rebuild).
