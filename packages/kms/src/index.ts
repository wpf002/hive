/**
 * @hive/kms — pluggable Key Encryption Key provider.
 *
 *   import { getKmsProvider } from '@hive/kms';
 *   const kms = getKmsProvider();
 *   const dek = randomBytes(32);
 *   const wrapped = await kms.encryptDek(dek);
 *
 * Selection: HIVE_KMS_PROVIDER env var, one of 'static' (default) | 'aws'.
 * Other providers (GCP, Vault, …) plug in by implementing HiveKmsProvider.
 */
export type { EncryptedDek, HiveKmsProvider } from './types.js';
export { StaticKeyKmsProvider } from './static-provider.js';
export { AwsKmsProvider } from './aws-provider.js';

import type { HiveKmsProvider } from './types.js';
import { StaticKeyKmsProvider } from './static-provider.js';
import { AwsKmsProvider } from './aws-provider.js';

let CACHED: HiveKmsProvider | null = null;

export type KmsProviderName = 'static' | 'aws';

export function resolveProviderName(): KmsProviderName {
  const raw = (process.env.HIVE_KMS_PROVIDER ?? 'static').trim().toLowerCase();
  if (raw === 'aws') return 'aws';
  if (raw === 'static' || raw === '') return 'static';
  throw new Error(`Unknown HIVE_KMS_PROVIDER='${raw}'. Expected 'static' or 'aws'.`);
}

export function buildKmsProvider(): HiveKmsProvider {
  const name = resolveProviderName();
  if (name === 'aws') return new AwsKmsProvider();
  return new StaticKeyKmsProvider();
}

/** Process-wide singleton. Reset with `__resetKmsProviderForTests()` if needed. */
export function getKmsProvider(): HiveKmsProvider {
  if (!CACHED) CACHED = buildKmsProvider();
  return CACHED;
}

export function __resetKmsProviderForTests(): void {
  CACHED = null;
}
