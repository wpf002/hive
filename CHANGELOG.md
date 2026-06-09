# Changelog

All notable changes to Hive are documented here.

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
- Job execution is admin-only: creating, editing, deleting, and running bots,
  plus creating/editing/deleting schedules and cancelling jobs, require the
  `admin` role. Non-admin users have read-only visibility. UI hides controls
  they can't use.

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
