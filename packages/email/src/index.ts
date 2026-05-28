import { LogOnlyEmailProvider } from './log-provider.js';
import { ResendEmailProvider } from './resend-provider.js';
import type { HiveEmailProvider } from './types.js';

export type { HiveEmailProvider, SendEmailOptions } from './types.js';
export { LogOnlyEmailProvider } from './log-provider.js';
export { ResendEmailProvider } from './resend-provider.js';

export interface EmailProviderEnv {
  HIVE_EMAIL_PROVIDER?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
}

/**
 * Selects the email provider from env. 'resend' wires the real sender (and
 * throws early if its config is missing — fail fast at boot, not at send time).
 * Anything else (including unset) returns the log-only provider so dev/CI never
 * sends real mail.
 */
export function createEmailProvider(env: EmailProviderEnv = process.env): HiveEmailProvider {
  if (env.HIVE_EMAIL_PROVIDER === 'resend') {
    return new ResendEmailProvider({
      apiKey: env.RESEND_API_KEY ?? '',
      from: env.RESEND_FROM_EMAIL ?? '',
    });
  }
  return new LogOnlyEmailProvider();
}
