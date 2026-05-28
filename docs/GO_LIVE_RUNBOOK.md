# Go-Live Runbook

The doc you follow on launch day. Cold → live in ~3 hours. Every section has a
**GATE** you must pass before moving on, and a **ROLLBACK** if it fails. Don't
skip gates. Target platform: **Fly.io** (AWS Terraform stays unused).

Legend: ⏱ = time estimate, ✅ GATE, ↩ ROLLBACK.

---

## 1. Pre-flight ⏱ 30 min (before)

1. Walk every box in [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md). All
   must be ticked.
2. `pnpm verify` and `pnpm --filter @hive/crypto crosslang-test` on `main`.
3. `./scripts/generate-production-secrets.sh` → copy each value into your
   password manager. Build `deploy/fly/.secrets.env` (gitignored) from them, and
   add the provider keys (`ANTHROPIC_API_KEY`, `ODDS_API_KEY`, `RESEND_API_KEY`,
   the Tigris `AWS_*` pair, `ADMIN_EMAIL`, `RESEND_FROM_EMAIL`, …).
4. `printf '\033c'` to clear the secret output from your terminal.

✅ GATE: checklist 100% ticked; `pnpm verify` green on the deploy commit.
↩ ROLLBACK: none — don't start until this passes.

---

## 2. Infrastructure provisioning ⏱ 45 min

1. `FLY_ORG=<org> FLY_REGION=ord ./deploy/fly/provision.sh`
2. Do the two manual steps it prints:
   - Upstash Redis: `flyctl redis create …`, then set `REDIS_URL` on every app.
   - Tigris bucket: `flyctl storage create --app hive-api --name hive-artifacts-prod`
     — capture the `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` into `.secrets.env`.
3. `./deploy/fly/set-secrets.sh ./deploy/fly/.secrets.env`

✅ GATE: `flyctl secrets list -a hive-api` shows DATABASE_URL, REDIS_URL,
HIVE_SECRETS_KEY, API_AUTH_TOKEN, RESEND_API_KEY, AWS_ACCESS_KEY_ID, … and the
same for each service per `secrets-manifest.yaml`.
↩ ROLLBACK: secrets are re-settable; re-run `set-secrets.sh` (idempotent). If an
app was created wrong, `flyctl apps destroy <app>` and re-run `provision.sh`.

---

## 3. Database initialization ⏱ 15 min

Migrations run **automatically** as the api app's `[deploy] release_command`
when you deploy the API in section 4 (Fly runs it on the private network, where
the private-only `DATABASE_URL` resolves, and aborts the deploy if it fails). So
this section is really just verification + seed, done right after the api deploy:

1. Verify: `flyctl postgres connect -a hive-pg -c 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;'`
   — expect the full migration count (10 as of Phase 6). The migration output is
   also in the api deploy log.
2. Seed (the api machine now exists; `deploy-production.sh` does this for you):
   `flyctl ssh console -a hive-api -C "pnpm --filter @hive/api seed"`
3. `flyctl postgres connect -a hive-pg -c 'SELECT email, role FROM "User" WHERE role='"'"'admin'"'"';'`

✅ GATE: `SELECT count(*) FROM "BotTemplate"` returns **30+**, and the admin user
exists.
↩ ROLLBACK: restore Fly Postgres from the most recent snapshot
(`flyctl postgres backup list/restore -a hive-pg`), fix the issue locally, retry.

---

## 4. Deployment ⏱ 30 min

1. `AUTH_TOKEN=<API_AUTH_TOKEN> ./deploy/fly/deploy-production.sh`
   (migrate → seed → api → verify → dispatcher/scheduler/sweeper → verify → ui →
   workers → wait 30s → smoke). Watch each step's output.

✅ GATE: the script's embedded `smoke-cloud.sh` prints `✓ smoke OK`.
↩ ROLLBACK: a single failed service rolls back with
`flyctl deploy -a <app> --image <previous-image-ref>` (find refs:
`flyctl releases -a <app>`). The script is resumable — fix and re-run.

---

## 5. Domain + TLS ⏱ 15 min

1. UI: `flyctl certs create hive.<yourdomain> -a hive-ui`; add the printed
   A/AAAA (or CNAME → `hive-ui.fly.dev`) records at your DNS provider.
2. API: `flyctl certs create api.hive.<yourdomain> -a hive-api`; add its records.
3. Set the UI's API base to the custom domain:
   `flyctl secrets set -a hive-ui NEXT_PUBLIC_API_BASE=https://api.hive.<yourdomain>`
   (redeploys the UI).
4. Wait for LetsEncrypt issuance (1–5 min; DNS propagation can be slower).
5. Set DNS TTL to **5 min** during setup; raise to **1 hour** once stable.

✅ GATE: `curl -I https://hive.<yourdomain>` and
`curl -I https://api.hive.<yourdomain>/healthz` both return 200 with a valid cert.
↩ ROLLBACK: none needed — retry. **Do not** flip `SECURE_COOKIES` off to "fix" a
cert problem; cert failures are almost always DNS. Verify with
`flyctl certs show <domain> -a <app>`.

---

## 6. Email verification ⏱ 10 min

1. In the Resend dashboard, confirm the sending domain is **Verified** (SPF +
   DKIM + DMARC DNS records propagated — 5–15 min).
2. End-to-end test: on `https://hive.<yourdomain>/forgot-password` request a reset
   for the admin email.

✅ GATE: the reset email arrives within 60s; the link opens `/reset-password`,
sets a new password, and you can log in with it. (Old sessions are invalidated.)
↩ ROLLBACK: if mail doesn't arrive, re-check Resend domain status and
`RESEND_FROM_EMAIL` (must be on the verified domain). Until fixed, set
`HIVE_EMAIL_PROVIDER=log` and read the link from `flyctl logs -a hive-api`.

---

## 7. External monitoring ⏱ 10 min

1. Per [`MONITORING.md`](./MONITORING.md), create UptimeRobot / Better Stack
   monitors for `https://hive.<yourdomain>/login` and
   `https://api.hive.<yourdomain>/healthz` (1-min interval).
2. Trigger a test alert.

✅ GATE: the test alert arrives via your configured channel within 5 min.
↩ ROLLBACK: none — monitoring is additive.

---

## 8. Smoke verification ⏱ 15 min

1. Log in as admin via the custom domain.
2. Run the six flows from the CLI with the gate enabled:
   `STRICT=1 API_BASE=https://api.hive.<yourdomain> AUTH_TOKEN=<token> ./scripts/smoke-cloud.sh`
   (add `SMOKE_MCP=1` after starting a Hive MCP Server bot to include the MCP
   Tool Tester flow).

✅ GATE: `PASS=6 FAIL=0` — Cron Heartbeat, ESPN scrape, AI Single Call, Full Page
Screenshot (artifact uploaded ✓), Trading paper order, and MCP Tool Tester all
succeed.
↩ ROLLBACK: file an issue, **do not announce**. Don't roll back unless severely
broken — diagnose with `flyctl logs -a hive-worker-<pool>`. A single failing
pool usually means that worker isn't scaled up or is missing a provider key.

---

## 9. Final ⏱ 5 min

1. Update `README.md` with the production URL.
2. `git tag v1.0.0 && git push --tags`
3. Announce internally / to early users.

✅ GATE: tag pushed, README updated, monitors green.

> Only create the `v1.0.0` tag once a **real deploy** has passed gate 8 in
> production. If you're only staging the artifacts, skip the tag.

---

## Quick rollback reference

| Gate | Symptom | Action |
|------|---------|--------|
| 3 | migration failed / half-applied | restore Fly PG snapshot, investigate locally |
| 4 | a service won't deploy/serve | `flyctl deploy -a <app> --image <prev ref>` |
| 5 | TLS cert won't issue | retry; fix DNS; do NOT touch SECURE_COOKIES |
| 6 | reset email never arrives | re-check Resend domain; temp `HIVE_EMAIL_PROVIDER=log` |
| 8 | a smoke flow fails | file issue, don't announce; check that pool's worker + keys |
