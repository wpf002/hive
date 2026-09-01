import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma, Prisma } from '@hive/db';
import { SWARM_ROLES, ROLE_SUBSCRIPTIONS, type SwarmRole } from '@hive/swarm';
import { requireAuth, requireRole } from '../auth.js';
import { writeAuditLog } from '../lib/audit.js';

/**
 * Mission CRUD + the approval gate.
 *
 * Read access follows the same ownership rule as bots: a user sees their own
 * missions, an admin sees everything. Anything that can *cause an effect* —
 * starting a mission, approving a proposal — is admin-only, matching the
 * execution boundary the rest of the API enforces (see routes/bots.ts).
 */

function isAdmin(req: FastifyRequest): boolean {
  return req.staticAuth === 'api' || req.user?.role === 'admin';
}

function missionOwnerFilter(req: FastifyRequest): { userId?: string } {
  if (isAdmin(req)) return {};
  return { userId: req.user?.id ?? 'nobody' };
}

const Limits = z.record(z.number()).default({});

const Create = z.object({
  name: z.string().min(1),
  domain: z.string().min(1),
  objective: z.string().min(1).max(4000),
  // Start every new mission read-only. Widening is a deliberate act.
  allowedActions: z.array(z.string().min(1)).default(['notify']),
  limits: Limits,
  approvalMode: z.enum(['manual', 'auto_below_threshold']).default('manual'),
});

const Patch = z.object({
  name: z.string().min(1).optional(),
  objective: z.string().min(1).max(4000).optional(),
  status: z.enum(['draft', 'running', 'paused', 'stopped']).optional(),
  allowedActions: z.array(z.string().min(1)).optional(),
  limits: z.record(z.number()).optional(),
  approvalMode: z.enum(['manual', 'auto_below_threshold']).optional(),
});

const AddAgent = z.object({
  botId: z.string().min(1),
  role: z.enum(SWARM_ROLES),
  subscribes: z.array(z.string()).optional(),
  // Gatherers own exactly one upstream source. That rule is what makes
  // deduplication possible downstream, so it's enforced here, not documented.
  sourceId: z.string().min(1).optional(),
});

export async function missionRoutes(app: FastifyInstance) {
  app.get('/api/missions', { preHandler: requireAuth('api') }, async (req) => {
    return prisma.mission.findMany({
      where: missionOwnerFilter(req),
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { agents: true, findings: true, hypotheses: true } },
      },
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/missions/:id',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const mission = await prisma.mission.findFirst({
        where: { id: req.params.id, ...missionOwnerFilter(req) },
        include: {
          agents: {
            include: { bot: { select: { id: true, name: true, template: { select: { poolType: true } } } } },
            orderBy: { createdAt: 'asc' },
          },
          proposals: { orderBy: { createdAt: 'desc' }, take: 20 },
        },
      });
      if (!mission) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'mission not found' } });
      }
      return mission;
    },
  );

  app.post('/api/missions', { preHandler: requireAuth('api') }, async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) {
      return reply.code(401).send({ error: { code: 'no_session', message: 'session required' } });
    }
    const body = Create.parse(req.body);
    // Widening the action set is an admin decision wherever it happens. It's
    // gated on PATCH, so leaving it open on create would just be a different
    // door to the same room: a non-admin could create the mission with the
    // actions already widened.
    if (!isAdmin(req) && body.allowedActions.some((a) => a !== 'notify')) {
      return reply.code(403).send({
        error: {
          code: 'forbidden',
          message: 'admin role required to allow actions beyond "notify"',
        },
      });
    }
    const mission = await prisma.mission.create({
      data: {
        userId,
        name: body.name,
        domain: body.domain,
        objective: body.objective,
        allowedActions: body.allowedActions,
        limits: body.limits as Prisma.InputJsonValue,
        approvalMode: body.approvalMode,
      },
    });
    return reply.code(201).send(mission);
  });

  // Editing a mission's objective or limits is ordinary ownership-scoped work,
  // but moving it to `running` starts real execution — admin only.
  app.patch<{ Params: { id: string } }>(
    '/api/missions/:id',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const body = Patch.parse(req.body);
      const existing = await prisma.mission.findFirst({
        where: { id: req.params.id, ...missionOwnerFilter(req) },
      });
      if (!existing) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'mission not found' } });
      }
      if (body.status === 'running' && !isAdmin(req)) {
        return reply
          .code(403)
          .send({ error: { code: 'forbidden', message: 'admin role required to run a mission' } });
      }
      if (body.allowedActions && !isAdmin(req)) {
        return reply.code(403).send({
          error: { code: 'forbidden', message: 'admin role required to change allowed actions' },
        });
      }
      const updated = await prisma.mission.update({
        where: { id: req.params.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.objective !== undefined ? { objective: body.objective } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.allowedActions !== undefined ? { allowedActions: body.allowedActions } : {}),
          ...(body.limits !== undefined ? { limits: body.limits as Prisma.InputJsonValue } : {}),
          ...(body.approvalMode !== undefined ? { approvalMode: body.approvalMode } : {}),
        },
      });
      // Stopping a mission must stop its feeds too. The coordinator's loops
      // exit on a status change, so model spend halts on its own — but the
      // gatherers are ordinary scheduled bots, and the scheduler would keep
      // firing them into workers for a mission nobody is watching. "Stop" that
      // leaves the meter running is not a stop.
      if (body.status && body.status !== existing.status) {
        const resuming = body.status === 'running';
        if (resuming || existing.status === 'running') {
          const agents = await prisma.missionAgent.findMany({
            where: { missionId: updated.id, role: 'gatherer' },
            select: { botId: true },
          });
          const botIds = agents.map((a) => a.botId);
          if (botIds.length > 0) {
            await prisma.schedule.updateMany({
              where: { botId: { in: botIds } },
              data: resuming
                ? { enabled: true, nextRunAt: new Date() }
                : { enabled: false, nextRunAt: null },
            });
          }
        }
      }

      if (body.status && body.status !== existing.status) {
        await writeAuditLog(req, {
          userId: req.user?.id,
          action: `mission.${body.status}`,
          targetType: 'mission',
          targetId: updated.id,
          payload: { from: existing.status },
        });
      }
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/missions/:id',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const existing = await prisma.mission.findFirst({
        where: { id: req.params.id, ...missionOwnerFilter(req) },
      });
      if (!existing) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'mission not found' } });
      }
      await prisma.mission.delete({ where: { id: req.params.id } });
      return reply.code(204).send();
    },
  );

  // ---- agents -------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/api/missions/:id/agents',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const body = AddAgent.parse(req.body);
      const mission = await prisma.mission.findFirst({
        where: { id: req.params.id, ...missionOwnerFilter(req) },
      });
      if (!mission) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'mission not found' } });
      }
      const bot = await prisma.bot.findFirst({
        where: { id: body.botId, ...(isAdmin(req) ? {} : { userId: req.user?.id ?? 'nobody' }) },
      });
      if (!bot) {
        return reply
          .code(400)
          .send({ error: { code: 'invalid_bot', message: 'bot not found or not yours' } });
      }
      if (body.role === 'gatherer') {
        if (!body.sourceId) {
          return reply.code(400).send({
            error: {
              code: 'source_required',
              message: 'a gatherer must declare the single sourceId it owns',
            },
          });
        }
        const clash = await prisma.missionAgent.findFirst({
          where: { missionId: mission.id, role: 'gatherer', sourceId: body.sourceId },
        });
        if (clash) {
          return reply.code(409).send({
            error: {
              code: 'source_taken',
              message: `source "${body.sourceId}" already has a gatherer in this mission. One gatherer per source — two would double-count as independent support.`,
            },
          });
        }
      }
      const agent = await prisma.missionAgent.create({
        data: {
          missionId: mission.id,
          botId: body.botId,
          role: body.role,
          subscribes: body.subscribes ?? ROLE_SUBSCRIPTIONS[body.role as SwarmRole],
          sourceId: body.sourceId ?? null,
        },
        include: { bot: { select: { id: true, name: true } } },
      });
      return reply.code(201).send(agent);
    },
  );

  app.delete<{ Params: { id: string; agentId: string } }>(
    '/api/missions/:id/agents/:agentId',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const agent = await prisma.missionAgent.findFirst({
        where: {
          id: req.params.agentId,
          mission: { id: req.params.id, ...missionOwnerFilter(req) },
        },
      });
      if (!agent) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'agent not found' } });
      }
      await prisma.missionAgent.delete({ where: { id: agent.id } });
      return reply.code(204).send();
    },
  );

  // ---- proposals ----------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/api/missions/:id/proposals',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const mission = await prisma.mission.findFirst({
        where: { id: req.params.id, ...missionOwnerFilter(req) },
        select: { id: true },
      });
      if (!mission) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'mission not found' } });
      }
      return prisma.proposal.findMany({
        where: { missionId: mission.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
    },
  );

  /**
   * The only place a human is in the loop, so it's the strictest endpoint here.
   *
   * Admin-only (an approval causes a side effect, and job execution is
   * admin-only everywhere else), and the expiry re-check happens inside the
   * update predicate rather than as a read-then-write. A proposal that expires
   * between the read and the write must not be approvable, and an operator
   * clicking a stale button gets a 409 rather than a silent late execution.
   */
  app.post<{ Params: { id: string; proposalId: string }; Body: { note?: string } }>(
    '/api/missions/:id/proposals/:proposalId/approve',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const proposal = await prisma.proposal.findFirst({
        where: { id: req.params.proposalId, missionId: req.params.id },
      });
      if (!proposal) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'proposal not found' } });
      }
      if (proposal.status !== 'pending') {
        return reply.code(409).send({
          error: { code: 'not_pending', message: `proposal is ${proposal.status}` },
        });
      }

      // Conditional update: only flips if it is *still* pending and unexpired.
      const { count } = await prisma.proposal.updateMany({
        where: { id: proposal.id, status: 'pending', expiresAt: { gt: new Date() } },
        data: {
          status: 'approved',
          decidedById: req.user?.id ?? null,
          decidedAt: new Date(),
        },
      });
      if (count === 0) {
        await prisma.proposal.updateMany({
          where: { id: proposal.id, status: 'pending' },
          data: { status: 'expired' },
        });
        return reply.code(409).send({
          error: {
            code: 'expired',
            message: 'this proposal expired before the approval landed and was not executed',
          },
        });
      }

      await writeAuditLog(req, {
        userId: req.user?.id,
        action: 'proposal.approve',
        targetType: 'proposal',
        targetId: proposal.id,
        payload: { missionId: proposal.missionId, action: proposal.action },
      });
      return prisma.proposal.findUnique({ where: { id: proposal.id } });
    },
  );

  app.post<{ Params: { id: string; proposalId: string } }>(
    '/api/missions/:id/proposals/:proposalId/reject',
    { preHandler: requireRole('admin') },
    async (req, reply) => {
      const { count } = await prisma.proposal.updateMany({
        where: { id: req.params.proposalId, missionId: req.params.id, status: 'pending' },
        data: { status: 'rejected', decidedById: req.user?.id ?? null, decidedAt: new Date() },
      });
      if (count === 0) {
        return reply
          .code(409)
          .send({ error: { code: 'not_pending', message: 'proposal is no longer pending' } });
      }
      await writeAuditLog(req, {
        userId: req.user?.id,
        action: 'proposal.reject',
        targetType: 'proposal',
        targetId: req.params.proposalId,
        payload: { missionId: req.params.id },
      });
      return prisma.proposal.findUnique({ where: { id: req.params.proposalId } });
    },
  );
}
