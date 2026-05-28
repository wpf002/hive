import { randomUUID } from 'node:crypto';
import type { HiveEmailProvider, SendEmailOptions } from './types.js';

/**
 * Dev/CI provider — logs the email to stdout and NEVER sends real mail.
 * Default when HIVE_EMAIL_PROVIDER is unset or 'log'. Lets the full password
 * reset flow be exercised locally (copy the link straight out of the logs).
 */
export class LogOnlyEmailProvider implements HiveEmailProvider {
  async send(opts: SendEmailOptions): Promise<{ id: string }> {
    const id = `log-${randomUUID()}`;
    // Single structured line so it's greppable in pino/journald.
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        provider: 'log',
        event: 'email.send',
        id,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
      }),
    );
    return { id };
  }
}
