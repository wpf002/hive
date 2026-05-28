export interface SendEmailOptions {
  to: string;
  subject: string;
  /** HTML body. Always provide a `text` fallback too — many clients prefer it. */
  html: string;
  text: string;
}

export interface HiveEmailProvider {
  /** Sends one transactional email. Resolves with the provider message id.
   *  Implementations throw on a hard failure (bad key, 4xx/5xx) so callers can
   *  decide whether to surface or swallow it. */
  send(opts: SendEmailOptions): Promise<{ id: string }>;
}
