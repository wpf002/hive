# Deploying Hive to Railway

Railway is the "middle option" between Fly and AWS — easier than AWS,
slightly more polished than Fly, and integrates first-class managed Postgres
+ Redis. It&rsquo;s the right call if your team is already on Railway for other
projects.

## What you get for free

- Managed Postgres add-on (provides `DATABASE_URL`).
- Managed Redis add-on (provides `REDIS_URL`).
- Built-in environment + secret management with per-environment overrides.
- Per-service deploy logs and metrics.

## What you bring yourself

- **S3-compatible object storage**: Railway has no native bucket service. Use
  Backblaze B2 (cheap, S3-compatible) or Cloudflare R2. Set
  `HIVE_ARTIFACT_S3_ENDPOINT` accordingly.
- **KMS**: Railway has no managed KMS. Use the static-key provider just like
  Fly — `HIVE_KMS_PROVIDER=static`, `HIVE_SECRETS_KEY=<openssl rand -hex 32>`.

## One-time setup

```bash
npm i -g @railway/cli
railway login
railway init       # creates a Railway project linked to this repo
railway link       # link your local clone to the Railway project
```

Add the Postgres + Redis plugins from the Railway UI (or `railway add`).
Note the auto-generated `DATABASE_URL` and `REDIS_URL`.

Then create each Hive service from its `railway.*.json` config. From the
project root:

```bash
for cfg in deploy/railway/railway.*.json; do
  name=$(basename "$cfg" .json)            # e.g. railway.api -> railway.api
  service=${name#railway.}                 # api, dispatcher, ...
  railway service create "$service"
done
```

For each service, copy/paste the shared env vars from the Railway UI
(`DATABASE_URL`, `REDIS_URL`, `API_AUTH_TOKEN`, `WORKER_AUTH_TOKEN`,
`HIVE_SECRETS_KEY`, etc.). Per-service vars:

- API: also needs `JWT_SECRET`, `SESSION_SECRET`, `ADMIN_EMAIL`,
  `ADMIN_PASSWORD`, plus the S3 vars.
- UI: needs `NEXT_PUBLIC_API_BASE` pointing at the public API URL.
- Workers: need `WORKER_AUTH_TOKEN` + provider keys (`ANTHROPIC_API_KEY`,

## Deploying

```bash
# Push the current commit to every service.
railway up

# Or per-service.
railway service select api
railway up
```

Railway picks up `deploy/railway/railway.<service>.json` automatically when
the service name matches.

## Migrations

Use a Railway one-off shell:

```bash
railway run --service api -- pnpm --filter @hive/db migrate deploy
railway run --service api -- pnpm --filter @hive/api seed
railway run --service api -- pnpm --filter @hive/api upgrade-envelope-v1-to-v2
```

## Known friction points

- Railway's free tier shuts services down after periods of inactivity. The
  dispatcher needs to be up continuously — upgrade to the Pro plan or you'll
  see jobs stuck in `queued`.
- Multi-arch image builds aren't first-class on Railway. You may need to push
  pre-built images to Docker Hub / GHCR and reference them from
  `dockerfilePath` (use a registry-fetch step instead).
- Backblaze B2's SigV2 vs SigV4: the `@aws-sdk/s3-request-presigner` flow
  works with B2's SigV4 endpoint but the URL hostname differs from AWS —
  test the presigned-download flow end-to-end before going live.
