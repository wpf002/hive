# Secret handling

Hive stores per-bot secrets (Discord tokens, exchange API keys, …) inside `Bot.config` as JSON. Since Phase 4a those values are encrypted at rest using XChaCha20-Poly1305 AEAD.

## Wire format

```
hive:enc:v1:<base64( nonce(24 bytes) || ciphertext+tag(16 bytes) )>
```

The same format is produced and consumed by:
- TypeScript: [`@hive/crypto`](../packages/crypto/src/index.ts) (via `sodium-native`)
- Python: [`hive_base.crypto`](../workers/base/hive_base/crypto.py) (via `pynacl`)

Both modules load the master key from the `HIVE_SECRETS_KEY` environment variable (32 raw bytes = 64 hex chars). The API process refuses to start without it; workers fail loudly the first time they try to decrypt.

Generate a key:

```
openssl rand -hex 32
```

## Marking a field as secret

In a template's JSON Schema, set `x-secret: true` on any string property:

```ts
configSchema: {
  type: 'object',
  required: ['botToken', 'chatId'],
  properties: {
    botToken: {
      type: 'string',
      format: 'password',      // documentation only
      'x-secret': true,        // ← this is what the API keys off
    },
    chatId: { type: 'string' },
  },
}
```

The API walks the schema on every write and encrypts any matching property in the bot's config.

## Lifecycle of a secret

| Stage                | Format                                    | Lives where                    |
|----------------------|-------------------------------------------|--------------------------------|
| Submitted by UI/CLI  | plaintext                                 | HTTPS request body             |
| Stored in Postgres   | `hive:enc:v1:…`                           | `Bot.config` JSON              |
| Returned over HTTP   | `****encrypted` (or `****last4` if pre-migration plaintext) | API GET responses              |
| Dispatched to worker | plaintext                                 | Redis `hive:dispatch` stream + worker process memory |

Encrypting the dispatch payload itself is **Phase 5 work** (needs KMS for per-worker key distribution). For now, secrets are exposed to anything with `WORKER_AUTH_TOKEN` and Redis access.

## Migrating existing rows

A one-shot script encrypts any plaintext value sitting in `Bot.config` whose template now marks the field `x-secret: true`:

```
pnpm db:migrate                              # no schema change; still safe to re-run
pnpm --filter @hive/api seed                 # updates template schemas to add x-secret flags
pnpm --filter @hive/api encrypt-existing-secrets   # idempotent re-run is a no-op
```

The script round-trips every value it touches through `decrypt()` before exiting to catch a misconfigured key early.

## Rotating the master key

There is **no automatic re-encryption path yet**. Rotating `HIVE_SECRETS_KEY` strands every encrypted value already in Postgres. `make rotate-secrets-key` currently prints the manual playbook; full rotation lands in Phase 5.

## Verification

Cross-language ciphertext compatibility is asserted by:

```
pnpm --filter @hive/crypto crosslang-test
```

The test encrypts a string in TS, decrypts in Python, then reverses the direction. Skips with exit 0 if the Python venv isn't installed; pass `--strict` to fail-hard.
