import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  API_AUTH_TOKEN: z.string().min(16),
  WORKER_AUTH_TOKEN: z.string().min(16),
  TRADING_LIVE_ENABLED: z.enum(['true', 'false']).default('false'),
  // Phase 4a: required for field-level encryption of bot secrets.
  // 32 raw bytes = 64 hex chars. @hive/crypto re-validates the format.
  HIVE_SECRETS_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'HIVE_SECRETS_KEY must be 64 hex chars (32 bytes). Generate with `openssl rand -hex 32`.'),
  // Phase 4b: where artifact files live on disk. Used by the local storage
  // provider; ignored when HIVE_STORAGE_PROVIDER=s3.
  HIVE_ARTIFACT_DIR: z.string().min(1).default('./data/artifacts'),
  // Phase 5a: storage backend selection.
  HIVE_STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  // Phase 5a: S3-compatible artifact storage (set when HIVE_STORAGE_PROVIDER=s3).
  HIVE_ARTIFACT_S3_BUCKET: z.string().optional(),
  HIVE_ARTIFACT_S3_ENDPOINT: z.string().optional(),
  HIVE_ARTIFACT_S3_REGION: z.string().optional(),
  // Phase 5a: KMS provider for envelope encryption.
  HIVE_KMS_PROVIDER: z.enum(['static', 'aws']).default('static'),
  HIVE_KMS_KEY_ID: z.string().optional(),
  HIVE_KMS_STATIC_KEY_ID: z.string().optional(),
  HIVE_KMS_STATIC_RETIRED_KEYS: z.string().optional(),
  // Optional: used to construct presigned URLs (defaults to localhost:API_PORT).
  API_BASE_URL: z.string().optional(),
  // Phase 6b: transactional email (password reset, audit alerts).
  // 'log' (default) never sends real mail; 'resend' uses the Resend REST API.
  HIVE_EMAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().optional(),
  // Public origin of the UI, used to build the password-reset link and as the
  // primary allowed CORS origin. Defaults to the local dev UI port; set to
  // https://hive.<yourdomain> in production.
  HIVE_PUBLIC_APP_URL: z.string().default('http://localhost:3001'),
  // Optional extra browser origins allowed to make credentialed CORS requests,
  // comma-separated (e.g. "https://admin.example.com,https://staging.example.com").
  // HIVE_PUBLIC_APP_URL is always allowed; localhost is auto-allowed in dev.
  HIVE_CORS_ORIGINS: z.string().optional(),
  // AI bot builder: lets operators describe a bot in plain English and have
  // Claude pick the best-fit template + fill its config. Optional — when unset,
  // POST /api/bot-builder/suggest returns 503 and the feature is hidden in the
  // UI. Reuses ANTHROPIC_API_KEY if the ai_agent worker key is shared.
  ANTHROPIC_API_KEY: z.string().optional(),
  HIVE_BOT_BUILDER_MODEL: z.string().default('claude-sonnet-4-5'),
  // Phase 6b (optional): if set, critical audit events email this address. The
  // session-sweeper service runs the polling job; the API tolerates the var so
  // env validation stays uniform across services.
  HIVE_AUDIT_ALERT_EMAIL: z.string().optional(),
});

export const env = Env.parse(process.env);
export type AppEnv = z.infer<typeof Env>;
