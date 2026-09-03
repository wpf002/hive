import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@hive/db';
import { requireAuth } from '../auth.js';
import { verifyPassword } from '../lib/passwords.js';
import { writeAuditLog } from '../lib/audit.js';
import { revokeAllSessionsForUser } from '../lib/sessions.js';
import { maskBotConfig } from '../lib/secrets.js';

/**
 * The two things a person is entitled to do with their own data: take a copy,
 * and have it deleted.
 *
 * Neither existed. An admin could delete an account on someone's behalf, which
 * is not the same thing — it means asking permission to leave.
 */
export async function accountRoutes(app: FastifyInstance) {
  /**
   * Everything this account owns, as one JSON document.
   *
   * Bot configs go through the same masking the API uses everywhere else.
   * Secrets in a bot config are usually the customer's own credentials, but an
   * export is a file that ends up in a download folder, an email, a support
   * ticket — the one place a plaintext key is most likely to escape. Anyone who
   * needs the value has it already; they gave it to us.
   */
  app.get('/api/account/export', { preHandler: requireAuth('api') }, async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) {
      return reply
        .code(400)
        .send({ error: { code: 'no_user', message: 'export is per-account; use a user session' } });
    }

    const [user, bots, missions, alerts, periods, audit] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          displayName: true,
          role: true,
          plan: true,
          emailVerifiedAt: true,
          createdAt: true,
          lastLoginAt: true,
        },
      }),
      prisma.bot.findMany({
        where: { userId },
        include: { template: { select: { name: true, poolType: true, configSchema: true } } },
      }),
      prisma.mission.findMany({
        where: { userId },
        include: { agents: { select: { role: true, sourceId: true, subject: true } } },
      }),
      prisma.alert.findMany({ where: { userId } }),
      prisma.usagePeriod.findMany({ where: { userId }, orderBy: { periodStart: 'desc' } }),
      prisma.auditLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
    ]);
    if (!user) return reply.code(404).send({ error: { code: 'not_found', message: 'no account' } });

    await writeAuditLog(req, { userId, action: 'account.exported' });

    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header(
      'Content-Disposition',
      `attachment; filename="hive-export-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    return reply.send({
      exportedAt: new Date().toISOString(),
      account: user,
      bots: bots.map((b) => ({
        id: b.id,
        name: b.name,
        template: b.template.name,
        pool: b.template.poolType,
        enabled: b.enabled,
        createdAt: b.createdAt,
        config: maskBotConfig(b.template, b.config),
      })),
      missions: missions.map((m) => ({
        id: m.id,
        name: m.name,
        domain: m.domain,
        objective: m.objective,
        status: m.status,
        createdAt: m.createdAt,
        sources: [...new Set(m.agents.map((a) => a.sourceId).filter(Boolean))],
        subjects: [...new Set(m.agents.map((a) => a.subject).filter(Boolean))],
      })),
      alerts,
      // Billing history, because "what was I charged" is one of the questions
      // an export exists to answer.
      usagePeriods: periods.map((p) => ({
        start: p.periodStart,
        end: p.periodEnd,
        plan: p.planLabel,
        status: p.status,
        spendCents: Math.round(Number(p.modelCostMicroCents) / 100) / 100,
        modelCalls: p.modelCalls,
        jobsRun: p.jobsRun,
      })),
      auditLog: audit,
    });
  });

  /**
   * Delete your own account.
   *
   * Password-confirmed, because a session cookie on a shared machine should
   * not be enough to destroy someone's data, and this cannot be undone.
   */
  app.post('/api/account/delete', { preHandler: requireAuth('api') }, async (req, reply) => {
    const me = req.user;
    if (!me) {
      return reply
        .code(403)
        .send({ error: { code: 'forbidden', message: 'requires a real session' } });
    }
    const body = z.object({ password: z.string().min(1) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: me.id } });
    if (!user) return reply.code(404).send({ error: { code: 'not_found', message: 'no account' } });
    if (!(await verifyPassword(body.password, user.passwordHash))) {
      return reply
        .code(403)
        .send({ error: { code: 'bad_password', message: 'that password is not correct' } });
    }
    // Same guard the admin route has: an installation with no admin has no way
    // back in, and someone deleting their own account is the likeliest way to
    // arrive there.
    if (user.role === 'admin') {
      const admins = await prisma.user.count({ where: { role: 'admin' } });
      if (admins <= 1) {
        return reply.code(409).send({
          error: {
            code: 'last_admin',
            message:
              'You are the only admin. Promote another account before deleting this one, or the installation will be unreachable.',
          },
        });
      }
    }

    // Written before the delete, because the row it points at is about to stop
    // existing and this record has to outlive it.
    await writeAuditLog(req, {
      userId: user.id,
      action: 'account.self_deleted',
      targetType: 'user',
      targetId: user.id,
      payload: { email: user.email },
    });
    await revokeAllSessionsForUser(user.id);
    await prisma.user.delete({ where: { id: user.id } });
    reply.clearCookie('hive_session', { path: '/' });
    return reply.code(204).send();
  });
}
