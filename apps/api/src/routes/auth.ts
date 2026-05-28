import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@hive/db';
import { requireAuth, requireRole } from '../auth.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import {
  SESSION_COOKIE,
  cookieOptionsForSession,
  createSession,
  generateSessionToken,
  revokeAllSessionsForUser,
  revokeSession,
} from '../lib/sessions.js';
import { writeAuditLog } from '../lib/audit.js';
import { emailProvider } from '../lib/email.js';
import {
  buildResetLink,
  consumeResetToken,
  findValidResetToken,
  issueResetToken,
} from '../lib/reset-tokens.js';
import { env } from '../env.js';

const RequestPasswordResetBody = z.object({
  email: z.string().email(),
});

const ResetPasswordWithTokenBody = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).max(80),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

const CreateUserBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).max(80),
  role: z.enum(['admin', 'user']).default('user'),
});

const ResetPasswordBody = z.object({
  newPassword: z.string().min(8),
});

function publicUser(u: { id: string; email: string; displayName: string; role: string; createdAt: Date; lastLoginAt: Date | null }) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

export async function authRoutes(app: FastifyInstance) {
  // -------------------- public --------------------
  app.post('/api/auth/register', async (req, reply) => {
    if (process.env.SIGNUPS_ENABLED !== 'true') {
      return reply.code(403).send({
        error: { code: 'signups_disabled', message: 'self-signup is disabled — ask an admin to create your account' },
      });
    }
    const body = RegisterBody.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) return reply.code(409).send({ error: { code: 'email_taken', message: 'email is already registered' } });
    const passwordHash = await hashPassword(body.password);
    const user = await prisma.user.create({
      data: { email: body.email, displayName: body.displayName, passwordHash, role: 'user' },
    });
    await writeAuditLog(req, { userId: user.id, action: 'auth.register' });
    return reply.code(201).send(publicUser(user));
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      await writeAuditLog(req, { action: 'auth.login_failed', payload: { email: body.email } });
      return reply.code(401).send({ error: { code: 'invalid_credentials', message: 'email or password is incorrect' } });
    }
    const token = generateSessionToken();
    const { expiresAt } = await createSession({
      userId: user.id,
      token,
      ipAddress: req.ip,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    });
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await writeAuditLog(req, { userId: user.id, action: 'auth.login' });
    reply.setCookie(SESSION_COOKIE, token, cookieOptionsForSession());
    return reply.send({ user: publicUser({ ...user, lastLoginAt: new Date() }), expiresAt });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const cookies = (req as typeof req & { cookies?: Record<string, string | undefined> }).cookies;
    const token = cookies?.[SESSION_COOKIE];
    if (token) {
      await revokeSession(token);
      await writeAuditLog(req, { userId: req.user?.id ?? null, action: 'auth.logout' });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', { preHandler: requireAuth('api') }, async (req, reply) => {
    if (!req.user) {
      // Static-token caller — surface a synthetic identity rather than 401.
      return reply.send({
        id: 'static-token',
        email: 'api-token@hive',
        displayName: 'Static API token',
        role: 'admin',
        static: true,
      });
    }
    return reply.send(req.user);
  });

  app.post('/api/auth/change-password', { preHandler: requireAuth('api') }, async (req, reply) => {
    if (!req.user) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'password change requires a real session, not a static token' } });
    }
    const body = ChangePasswordBody.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || !(await verifyPassword(body.currentPassword, user.passwordHash))) {
      return reply.code(401).send({ error: { code: 'invalid_password', message: 'current password is incorrect' } });
    }
    const newHash = await hashPassword(body.newPassword);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
    await revokeAllSessionsForUser(user.id);
    await writeAuditLog(req, { userId: user.id, action: 'auth.password_changed' });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  // -------------------- password reset (Phase 6b) --------------------
  // Always returns 200 regardless of whether the email exists — this prevents
  // account enumeration. The real work (token + email) only happens when the
  // user is found.
  app.post('/api/auth/request-password-reset', async (req, reply) => {
    const body = RequestPasswordResetBody.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (user) {
      try {
        const { token } = await issueResetToken(user.id);
        const link = buildResetLink(env.HIVE_PUBLIC_APP_URL, token);
        await emailProvider().send({
          to: user.email,
          subject: 'Reset your Hive password',
          text: [
            `Hi ${user.displayName},`,
            '',
            'We received a request to reset your Hive password. Use the link below',
            'within the next hour to choose a new one:',
            '',
            link,
            '',
            "If you didn't request this, you can safely ignore this email — your",
            'password will not change.',
          ].join('\n'),
          html: [
            `<p>Hi ${user.displayName},</p>`,
            '<p>We received a request to reset your Hive password. Use the button',
            'below within the next hour to choose a new one:</p>',
            `<p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#f59e0b;color:#111;border-radius:6px;text-decoration:none;font-weight:600">Reset password</a></p>`,
            `<p style="color:#666;font-size:13px">Or paste this link into your browser:<br><a href="${link}">${link}</a></p>`,
            "<p style=\"color:#666;font-size:13px\">If you didn't request this, you can safely ignore this email.</p>",
          ].join(''),
        });
        await writeAuditLog(req, { userId: user.id, action: 'auth.password_reset_requested' });
      } catch (err) {
        // Never leak failure back to the caller (enumeration); log it server-side.
        req.log.error({ err, email: body.email }, 'password_reset_email_failed');
      }
    }
    return reply.send({ ok: true });
  });

  app.post('/api/auth/reset-password', async (req, reply) => {
    const body = ResetPasswordWithTokenBody.parse(req.body);
    const found = await findValidResetToken(body.token);
    if (!found) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_token', message: 'reset link is invalid or has expired' } });
    }
    const newHash = await hashPassword(body.newPassword);
    await prisma.user.update({ where: { id: found.userId }, data: { passwordHash: newHash } });
    await consumeResetToken(found.id);
    // Invalidate every existing session so a stolen session can't outlive the reset.
    await revokeAllSessionsForUser(found.userId);
    await writeAuditLog(req, { userId: found.userId, action: 'password_reset_completed' });
    return reply.send({ ok: true });
  });

  // -------------------- admin: users --------------------
  app.get('/api/admin/users', { preHandler: requireRole('admin') }, async () => {
    const rows = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(publicUser);
  });

  app.post('/api/admin/users', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = CreateUserBody.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) return reply.code(409).send({ error: { code: 'email_taken', message: 'email is already registered' } });
    const passwordHash = await hashPassword(body.password);
    const user = await prisma.user.create({
      data: { email: body.email, displayName: body.displayName, passwordHash, role: body.role },
    });
    await writeAuditLog(req, {
      userId: req.user?.id ?? null,
      action: 'admin.user_created',
      targetType: 'user',
      targetId: user.id,
      payload: { email: user.email, role: user.role },
    });
    return reply.code(201).send(publicUser(user));
  });

  app.post<{ Params: { id: string } }>(
    '/api/admin/users/:id/reset-password',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const body = ResetPasswordBody.parse(req.body);
      const user = await prisma.user.findUnique({ where: { id: req.params.id } });
      if (!user) return reply.code(404).send({ error: { code: 'not_found', message: 'user not found' } });
      const newHash = await hashPassword(body.newPassword);
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
      await revokeAllSessionsForUser(user.id);
      await writeAuditLog(req, {
        userId: req.user?.id ?? null,
        action: 'admin.password_reset',
        targetType: 'user',
        targetId: user.id,
      });
      return reply.send({ ok: true });
    },
  );

  app.get('/api/admin/audit', { preHandler: requireRole('admin') }, async (req) => {
    const Query = z.object({
      action: z.string().optional(),
      userId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    });
    const q = Query.parse(req.query);
    return prisma.auditLog.findMany({
      where: { action: q.action, userId: q.userId },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
      include: { user: { select: { id: true, email: true, displayName: true } } },
    });
  });
}
