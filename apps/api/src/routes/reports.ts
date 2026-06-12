import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createEmailProvider } from '@hive/email';
import { requireRole } from '../auth.js';
import { env } from '../env.js';
import {
  buildDigest,
  generateLessonsLearned,
  renderDigestHtml,
  renderDigestText,
} from '../lib/daily-digest.js';

const Query = z.object({
  // dryRun=true assembles + returns the digest without emailing (preview/testing).
  dryRun: z.coerce.boolean().optional(),
});

export async function reportRoutes(app: FastifyInstance) {
  // Generate the once-a-day bot-effectiveness digest and email it. Admin-only
  // (it reads every bot's results and triggers a send). The scheduler calls
  // this daily; it can also be hit manually to preview or force a send.
  app.post('/api/reports/daily-digest', { preHandler: requireRole('admin') }, async (req, reply) => {
    const q = Query.parse(req.query);
    const digest = await buildDigest();
    try {
      digest.lessonsLearned = await generateLessonsLearned(digest);
    } catch (e) {
      req.log.warn({ err: e }, 'lessons_learned_failed');
      digest.lessonsLearned = null;
    }

    const recipient = env.HIVE_DAILY_REPORT_EMAIL;
    let emailed = false;
    let emailError: string | null = null;

    if (!q.dryRun && recipient) {
      const provider = createEmailProvider(env);
      const subject = `🐝 Hive daily report — ${digest.totals.succeeded} ok, ${digest.totals.failed} failed`;
      try {
        await provider.send({
          to: recipient,
          subject,
          html: renderDigestHtml(digest),
          text: renderDigestText(digest),
        });
        emailed = true;
      } catch (e) {
        emailError = (e as Error).message;
        req.log.error({ err: e }, 'daily_digest_send_failed');
      }
    }

    return reply.send({
      ...digest,
      delivery: {
        emailed,
        recipient: recipient ?? null,
        provider: env.HIVE_EMAIL_PROVIDER,
        dryRun: q.dryRun ?? false,
        error: emailError,
        note: recipient
          ? env.HIVE_EMAIL_PROVIDER === 'resend'
            ? undefined
            : 'HIVE_EMAIL_PROVIDER is not "resend" — the report was rendered/logged but not actually sent.'
          : 'HIVE_DAILY_REPORT_EMAIL is unset — nowhere to send the report.',
      },
    });
  });
}
