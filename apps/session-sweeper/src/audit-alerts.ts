/**
 * Audit alerting (Phase 6b.2). Opt-in via HIVE_AUDIT_ALERT_EMAIL.
 *
 * Every AUDIT_ALERT_POLL_INTERVAL_S it scans the last few minutes of AuditLog
 * and emails the operator about critical events:
 *   - >5 failed logins within 10 minutes  (brute-force signal)
 *   - an admin role change
 *   - trading live mode enabled
 *   - a completed password reset
 *
 * Dedupe is backed by Redis (SET ... NX EX) so an event alerts exactly once,
 * even across restarts or multiple replicas. With no REDIS_URL it degrades to a
 * per-process in-memory set (fine for a single replica) and logs a warning.
 */
import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import { prisma } from '@hive/db';
import { createEmailProvider, type HiveEmailProvider } from '@hive/email';
import { env } from './env.js';

const LOOKBACK_MS = 5 * 60 * 1000; // scan the last 5 minutes each poll
const LOGIN_FAIL_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_FAIL_THRESHOLD = 5;
const DEDUPE_TTL_S = 24 * 60 * 60; // remember a fired alert for a day

// Single-occurrence rules: one matching AuditLog row → one alert.
interface SingleRule {
  label: string;
  match: (row: { action: string; payload: unknown }) => boolean;
}
const SINGLE_RULES: SingleRule[] = [
  { label: 'Password reset completed', match: (r) => r.action === 'password_reset_completed' },
  { label: 'Admin role change', match: (r) => r.action === 'admin.role_changed' },
  {
    label: 'New admin user created',
    match: (r) =>
      r.action === 'admin.user_created' &&
      typeof r.payload === 'object' &&
      r.payload !== null &&
      (r.payload as { role?: string }).role === 'admin',
  },
  { label: 'Trading LIVE mode enabled', match: (r) => r.action === 'trading.live_enabled' },
];

interface Deduper {
  /** Returns true if this is the first time we've seen `key` (i.e. fire now). */
  firstSeen(key: string): Promise<boolean>;
}

function redisDeduper(redis: Redis): Deduper {
  return {
    async firstSeen(key) {
      const res = await redis.set(`hive:auditalert:${key}`, '1', 'EX', DEDUPE_TTL_S, 'NX');
      return res === 'OK';
    },
  };
}

function memoryDeduper(): Deduper {
  const seen = new Set<string>();
  return {
    async firstSeen(key) {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };
}

export function startAuditAlerts(log: FastifyBaseLogger): void {
  const to = env.HIVE_AUDIT_ALERT_EMAIL;
  if (!to) {
    log.info('audit_alerts_disabled (set HIVE_AUDIT_ALERT_EMAIL to enable)');
    return;
  }

  const email: HiveEmailProvider = createEmailProvider({
    HIVE_EMAIL_PROVIDER: env.HIVE_EMAIL_PROVIDER,
    RESEND_API_KEY: env.RESEND_API_KEY,
    RESEND_FROM_EMAIL: env.RESEND_FROM_EMAIL,
  });

  let deduper: Deduper;
  if (env.REDIS_URL) {
    deduper = redisDeduper(new Redis(env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 3 }));
  } else {
    log.warn('audit_alerts: no REDIS_URL — using in-memory dedupe (single replica only)');
    deduper = memoryDeduper();
  }

  async function notify(subject: string, lines: string[]): Promise<void> {
    const text = lines.join('\n');
    try {
      await email.send({
        to: to!,
        subject,
        text,
        html: `<pre style="font:13px/1.5 monospace">${lines.join('\n')}</pre>`,
      });
      log.info({ subject }, 'audit_alert_sent');
    } catch (err) {
      log.error({ err, subject }, 'audit_alert_send_failed');
    }
  }

  async function poll(): Promise<void> {
    const since = new Date(Date.now() - LOOKBACK_MS);
    try {
      // --- single-occurrence rules ---
      const rows = await prisma.auditLog.findMany({
        where: { createdAt: { gt: since } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      for (const row of rows) {
        for (const rule of SINGLE_RULES) {
          if (!rule.match({ action: row.action, payload: row.payload })) continue;
          if (await deduper.firstSeen(`row:${row.id}`)) {
            await notify(`[Hive] ${rule.label}`, [
              `Event:   ${rule.label}`,
              `Action:  ${row.action}`,
              `User:    ${row.userId ?? '(none)'}`,
              `IP:      ${row.ipAddress ?? '(unknown)'}`,
              `When:    ${row.createdAt.toISOString()}`,
              `Payload: ${JSON.stringify(row.payload ?? {})}`,
            ]);
          }
        }
      }

      // --- failed-login threshold (>5 in 10 min) ---
      const failWindow = new Date(Date.now() - LOGIN_FAIL_WINDOW_MS);
      const failCount = await prisma.auditLog.count({
        where: { action: 'auth.login_failed', createdAt: { gt: failWindow } },
      });
      if (failCount > LOGIN_FAIL_THRESHOLD) {
        // Bucket the dedupe key to the 10-min window so we alert at most once
        // per window rather than every poll.
        const bucket = Math.floor(Date.now() / LOGIN_FAIL_WINDOW_MS);
        if (await deduper.firstSeen(`loginfail:${bucket}`)) {
          await notify('[Hive] Failed-login spike', [
            `${failCount} failed logins in the last 10 minutes (threshold ${LOGIN_FAIL_THRESHOLD}).`,
            'Check /admin/audit for the source IPs and targeted accounts.',
          ]);
        }
      }
    } catch (err) {
      log.error({ err }, 'audit_alert_poll_failed');
    }
  }

  log.info({ to, intervalSeconds: env.AUDIT_ALERT_POLL_INTERVAL_S }, 'audit_alerts_enabled');
  void poll();
  setInterval(() => void poll(), env.AUDIT_ALERT_POLL_INTERVAL_S * 1000);
}
