# Production Pre-Flight Checklist

Everything below must be **true and verified** before you run a single deploy
command. This is the gate for `GO_LIVE_RUNBOOK.md` section 1. Work top to
bottom — do not skip. Each box is actionable: if you can't tick it honestly,
stop and fix it first.

> Target platform for the initial production deploy is **Fly.io**. AWS Terraform
> (`deploy/aws/`) stays in the repo for a future migration and is **not** used
> here.

## Accounts & billing

- [ ] Fly.io account created with **billing enabled** (a card on file — free
      allowances run out fast once ~15 apps + Postgres are running).
- [ ] `flyctl` installed locally: `brew install flyctl` (or
      `curl -L https://fly.io/install.sh | sh`).
- [ ] Authenticated: `flyctl auth whoami` prints your email.
- [ ] A Fly **organization** chosen for these apps (`flyctl orgs list`). Note
      its slug — `provision.sh` uses `--org`.
- [ ] Resend account created; the sending domain (e.g. `hive.<yourdomain>`)
      added in the Resend dashboard (SPF/DKIM/DMARC DNS records will be added
      during 6b — they do not need to be verified yet, just the account ready).
- [ ] UptimeRobot **or** Better Stack account created (free tier is fine for
      two HTTPS monitors).

## Domain

- [ ] Custom domain registered and you have **DNS edit access** (you will add
      CNAME/A/AAAA + TXT records for both the app and the email domain).
- [ ] Decided on the hostnames:
  - UI:  `hive.<yourdomain>`
  - API: `api.hive.<yourdomain>`
  - From-address: `no-reply@hive.<yourdomain>`

## Code health (run these now, on the exact commit you will deploy)

- [ ] `git status` is clean and you are on the commit you intend to ship.
- [ ] `pnpm install` completes with no errors.
- [ ] `pnpm verify` passes (`pnpm -r typecheck && pnpm -r lint`).
- [ ] `pnpm --filter @hive/crypto crosslang-test` passes (TS⇄Python secret
      crypto round-trips — a mismatch here means workers can't decrypt secrets).
- [ ] All Phase 1–5 verification flows still pass locally:
  - [ ] Cron Heartbeat bot runs and succeeds
  - [ ] ESPN Scoreboard scrape runs and succeeds
  - [ ] AI Single Call runs and succeeds (with a real `ANTHROPIC_API_KEY`)
  - [ ] Full Page Screenshot uploads an artifact (browser pool)
  - [ ] Trading Market Order in **paper** mode runs and succeeds
  - [ ] A schedule fires the scheduler at least once
- [ ] `pnpm --filter @hive/api seed` is **idempotent** — run it twice locally
      against a seeded DB; the second run must not error or duplicate rows.

## Secrets

- [ ] You have a password manager (1Password / Bitwarden) ready to store the
      generated production secrets immediately after generation.
- [ ] You understand that `scripts/generate-production-secrets.sh` **prints**
      secrets and never writes them to disk — you must copy them into your
      password manager and clear scrollback afterward.

## Provider keys ready to paste (have these in hand)

- [ ] `ANTHROPIC_API_KEY` (worker-ai-agent)
- [ ] `OPENAI_API_KEY` (worker-ai-agent, optional but recommended)
- [ ] `PERPLEXITY_API_KEY` (worker-ai-agent, optional)
- [ ] `ODDS_API_KEY` (worker-scraper — the-odds-api.com)
- [ ] `RESEND_API_KEY` (api)
- [ ] `DISCORD_BOT_TOKEN` (worker-discord, optional)
- [ ] `TELEGRAM_BOT_TOKEN` (worker-telegram, optional)

## Final mental check

- [ ] `TRADING_LIVE_ENABLED` will be set to **`false`** on the trading worker
      (paper-only at launch — flip it deliberately later, never on day one).
- [ ] You have ~3 hours of uninterrupted time (see `GO_LIVE_RUNBOOK.md`).
- [ ] You know where the rollback procedures are (each gate in the runbook).
