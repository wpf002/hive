# Auth

Hive uses session cookies for UI traffic and bearer tokens for workers + CLI.

## What landed in Phase 3c

- New `User`, `Session`, `AuditLog` tables (migration `phase3_auth`).
- Bcrypt password hashing (cost 12). Sessions are random 32-byte tokens stored
  as SHA-256 hashes; 7-day expiry (sliding — re-issued on each login). Cookie
  is `hive_session`, `httpOnly` + `sameSite=lax`, `Secure` controlled by
  `SECURE_COOKIES=true`.
- Routes:
  - `POST /api/auth/login` → sets cookie + returns `{user, expiresAt}`.
  - `POST /api/auth/logout` → revokes session.
  - `GET /api/auth/me` → current user (or synthetic identity when called with
    the static `API_AUTH_TOKEN`).
  - `POST /api/auth/change-password` → invalidates all of the user's sessions.
  - `POST /api/auth/register` → disabled unless `SIGNUPS_ENABLED=true`.
  - Admin-only: `GET /api/admin/users`, `POST /api/admin/users`,
    `POST /api/admin/users/:id/reset-password`, `GET /api/admin/audit`.
- `requireAuth(scope)` accepts (in order) session cookie → bearer token. Worker
  routes still accept *only* the worker token. Admin-gated routes use
  `requireRole('admin')` — these include worker drain, job requeue, paper
  wallet seed, and the `/api/admin/*` family.
- Every admin action and every login/logout writes an `AuditLog` row with the
  user id, action, target (optional), and client IP.

## Backward compatibility

The static `API_AUTH_TOKEN` continues to work for scripts and CI.
`requireAuth('api')` accepts it; `requireRole('admin')` treats it as admin so
existing automation keeps working. Workers continue to use `WORKER_AUTH_TOKEN`
on `/api/workers/heartbeat` — workers have no user identity.

`NEXT_PUBLIC_API_TOKEN` has been retired from the UI client; the api wrapper
falls back to it only as a transition aid for the SSE stream. Any local `.env`
copy can drop the variable once you've logged in for the first time.

## First-run setup

`pnpm --filter @hive/api seed` checks for any user with `role='admin'`. If
none exists, it reads `ADMIN_EMAIL` + `ADMIN_PASSWORD` from the environment
and creates one. The seed *aborts* if either variable is missing and no admin
exists — Hive refuses to leave itself without an admin.

## Creating additional users

- Open the UI → user menu (top-right) → "Admin · Users".
- Or POST to `/api/admin/users` with admin credentials.
- Self-signup is off by default; flip `SIGNUPS_ENABLED=true` on the API to
  enable `/api/auth/register` (public form).

## Operational notes

- **Bcrypt cost.** 12 is comfortable on a modern x86 dev box (~150ms). For
  Alpine/Linux container images we observed it can run noticeably slower
  there; benchmark before Phase 5 cloud build.
- **CORS.** Fastify CORS is configured with `credentials: true` so the
  browser sends the session cookie cross-origin (UI on `:3001`, API on
  `:4000`). Don't change this without re-validating UI auth.
- **Rotation.** Static tokens never rotate automatically. To rotate, generate
  a new value with `openssl rand -hex 32`, update `.env` for the API +
  workers + UI build, restart, redeploy.
- **Session sweep.** Expired sessions are deleted lazily on lookup. There is
  no background sweeper yet — for prod, add a periodic `DELETE FROM "Session"
  WHERE "expiresAt" < now()` (cron, every 12 hours).
