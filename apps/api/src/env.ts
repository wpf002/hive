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
});

export const env = Env.parse(process.env);
export type AppEnv = z.infer<typeof Env>;
