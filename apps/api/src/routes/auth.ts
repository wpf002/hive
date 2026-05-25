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
