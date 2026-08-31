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
- **Closed five cross-tenant authorization gaps.** Hive is multi-tenant — a Bot
  carries a `userId` and Jobs, Artifacts, logs and trades inherit ownership
  through it — but several read routes never applied that filter and returned
  every tenant's data to any logged-in caller:
  - `GET /api/jobs` and `/api/jobs/:id` are now scoped to the caller's bots, and
    404 rather than 403 on someone else's job so they aren't an existence oracle.
    The DLQ (`/api/jobs/dlq`) is a cross-tenant ops view with no owner column, so
    it is admin-only; the UI's Quarantine tab is gated to match.
  - Job payloads no longer persist cleartext secrets. `POST /api/bots/:id/run`
    merged a cleartext `overrideConfig` into `Job.payload`, which was then served
    over HTTP; the payload is now masked on write and on read, so existing rows
    are covered without a migration.
  - Artifact listing, download and presigning check the owning job. The presign
    check matters most: the token it mints is a bearer capability carrying no
    further authorization.
  - `GET /api/jobs/:id/stream` scopes the SSE log firehose to the job's owner,
    matching what the mission stream already did.
  - `GET /api/paper-wallet`, `/api/trade-audit` and `/api/paper-trades` are
    ownership-scoped. `TradeAudit` includes `mode: 'live'` rows, so this was real
    order flow readable across tenants. The scope is ANDed with the query
    filters rather than spread beside them — both set `botId`, so at one object
    level `?botId=` would have overwritten the restriction instead of narrowing
    it. Note for operators: paper wallets are created with `botId` null by every
    funding path, so non-admins now see an empty wallet list.
- **SSRF guard on alert webhooks.** `POST /api/alerts`, `PATCH /api/alerts/:id`
  and the `slackWebhookUrl` field of `POST /api/onboarding` now refuse URLs
  resolving to private, loopback or link-local addresses (including the cloud
  metadata endpoint). The scheduler makes these requests and holds
  `API_AUTH_TOKEN`, `RESEND_API_KEY` and `DATABASE_URL`, so the forged request
  originated inside the control-plane network. Mirrors the guard the monitor
  worker already used; opt out with `HIVE_ALLOW_INTERNAL_WEBHOOKS=true`.
  The guard parses IPv6 rather than string-matching it — `new URL()`
  re-serializes `[::ffff:169.254.169.254]` as `[::ffff:a9fe:a9fe]`, so a check
  looking for a trailing dotted quad waved the metadata endpoint straight
  through. IPv4-mapped, NAT64 and 6to4 embedded addresses are all resolved to
  the IPv4 they carry. The scheduler also stops following redirects on webhook
  delivery, since a public host could otherwise 302 into the control plane
  after the URL passed validation.

### Fixed
- `GET /api/workers` no longer writes. It reaped stale workers with an
  `updateMany`, so a read verb mutated state and any caller with read access
  drove writes. Liveness is now derived from `lastSeenAt` at read time, and the
  singleton-pool busy check in `/run` reads `lastSeenAt` too — previously a
  worker that died mid-job kept its pool 429ing for up to `WORKER_REAP_AFTER_S`
  (default one hour).

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
