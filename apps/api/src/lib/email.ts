import { createEmailProvider, type HiveEmailProvider } from '@hive/email';
import { env } from '../env.js';

// One provider instance for the process. Constructed lazily so a missing
// RESEND_* config only blows up when email is actually configured (provider
// 'resend'), not at import time for the default 'log' provider.
let provider: HiveEmailProvider | null = null;

export function emailProvider(): HiveEmailProvider {
  if (!provider) {
    provider = createEmailProvider({
      HIVE_EMAIL_PROVIDER: env.HIVE_EMAIL_PROVIDER,
      RESEND_API_KEY: env.RESEND_API_KEY,
      RESEND_FROM_EMAIL: env.RESEND_FROM_EMAIL,
    });
  }
  return provider;
}
