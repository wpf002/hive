/**
 * Hermetic environment for UNIT tests. Import this FIRST, before any module
 * that transitively loads `../env.js` (which calls `Env.parse(process.env)` at
 * module-eval time and would otherwise throw on missing vars).
 *
 * ESM evaluates imported modules depth-first in source order, so a test file
 * that lists this import above its subject import is guaranteed to have these
 * values in place before `env.ts` parses. Values are deterministic so tests
 * never depend on a real `.env`; nothing here connects to a real service.
 */
process.env.NODE_ENV = 'production'; // exercise the strict (non-dev) code paths
process.env.DATABASE_URL ??= 'postgresql://unit:unit@localhost:5999/unit_never_connects';
process.env.REDIS_URL ??= 'redis://localhost:6999';
process.env.API_AUTH_TOKEN = 'unit-test-api-token-deterministic';
process.env.WORKER_AUTH_TOKEN = 'unit-test-worker-token-deterministic';
// 64 hex chars = 32 bytes. Fixed so crypto round-trips are reproducible.
process.env.HIVE_SECRETS_KEY =
  '1111111111111111111111111111111111111111111111111111111111111111';
process.env.HIVE_KMS_PROVIDER = 'static';
process.env.HIVE_PUBLIC_APP_URL = 'https://hive.example.com';
process.env.HIVE_CORS_ORIGINS = 'https://admin.example.com';

export {};
