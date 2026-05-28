import type { HiveEmailProvider, SendEmailOptions } from './types.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface ResendProviderConfig {
  apiKey: string;
  /** RFC-5322 from address, e.g. "Hive <no-reply@hive.example.com>" or a bare
   *  "no-reply@hive.example.com". Must be on a verified Resend sending domain. */
  from: string;
}

/**
 * Resend provider. Talks to the Resend REST API directly with `fetch` rather
 * than pulling in the `resend` npm SDK — one less dependency, and the POST
 * /emails contract is tiny and stable. (The Phase 6 spec referenced an
 * "@resend/node" package; the actual SDK is `resend`. Using the REST API
 * sidesteps the naming mismatch and keeps the package install-free.)
 */
export class ResendEmailProvider implements HiveEmailProvider {
  private readonly apiKey: string;
  private readonly from: string;

  constructor(cfg: ResendProviderConfig) {
    if (!cfg.apiKey) throw new Error('ResendEmailProvider: RESEND_API_KEY is required');
    if (!cfg.from) throw new Error('ResendEmailProvider: RESEND_FROM_EMAIL is required');
    this.apiKey = cfg.apiKey;
    this.from = cfg.from;
  }

  async send(opts: SendEmailOptions): Promise<{ id: string }> {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend send failed: ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error('Resend send: response had no message id');
    return { id: data.id };
  }
}
