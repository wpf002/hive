import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, Prisma } from '@hive/db';
import { requireAuth, requireRole } from '../auth.js';
import { isAdmin, botOwnerFilter, visibleJobIds } from '../lib/ownership.js';
import { writeAuditLog } from '../lib/audit.js';

const SeedBody = z.object({
  exchange: z.string().min(1),
  currency: z.string().min(1),
  amount: z.number().positive(),
});

const AuditQuery = z.object({
  jobId: z.string().optional(),
  botId: z.string().optional(),
  mode: z.enum(['paper', 'live']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const PaperTradesQuery = z.object({
  botId: z.string().optional(),
  symbol: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export async function tradingRoutes(app: FastifyInstance) {
  // Seed / top up a paper wallet — admin only.
  app.post('/api/paper-wallet/seed', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = SeedBody.parse(req.body);
    const amount = new Prisma.Decimal(body.amount);
    const existing = await prisma.paperWallet.findUnique({
      where: { exchange_currency: { exchange: body.exchange, currency: body.currency } },
    });
    let result;
    let action: 'topped_up' | 'created';
    if (existing) {
      const updated = await prisma.paperWallet.update({
        where: { id: existing.id },
        data: { balance: existing.balance.plus(amount) },
      });
      result = updated;
      action = 'topped_up';
    } else {
      const created = await prisma.paperWallet.create({
        data: { exchange: body.exchange, currency: body.currency, balance: amount },
      });
      result = created;
      action = 'created';
    }
    await writeAuditLog(req, {
      userId: req.user?.id ?? null,
      action: 'paper_wallet.seed',
      targetType: 'paper_wallet',
      targetId: result.id,
      payload: { exchange: body.exchange, currency: body.currency, amount: body.amount, action },
    });
    return reply.code(action === 'created' ? 201 : 200).send({ ...result, seeded: body.amount, action });
  });

  // Wallets are shared desk state, so admins see all of them. A non-admin sees
  // only wallets bound to one of their own bots — an unbound wallet
  // (botId null) is desk-level and not theirs to read.
  app.get('/api/paper-wallet', { preHandler: requireAuth('api') }, async (req) => {
    if (isAdmin(req)) {
      return prisma.paperWallet.findMany({
        orderBy: [{ exchange: 'asc' }, { currency: 'asc' }],
      });
    }
    const bots = await prisma.bot.findMany({ where: botOwnerFilter(req), select: { id: true } });
    return prisma.paperWallet.findMany({
      where: { botId: { in: bots.map((b) => b.id) } },
      orderBy: [{ exchange: 'asc' }, { currency: 'asc' }],
    });
  });

  // TradeAudit carries mode:'live' rows, so an unscoped read exposed real
  // order flow across tenants.
  app.get('/api/trade-audit', { preHandler: requireAuth('api') }, async (req) => {
    const q = AuditQuery.parse(req.query);
    const scope: Prisma.TradeAuditWhereInput = {};
    if (!isAdmin(req)) {
      const bots = await prisma.bot.findMany({ where: botOwnerFilter(req), select: { id: true } });
      scope.botId = { in: bots.map((b) => b.id) };
    }
    // AND the scope rather than spreading it alongside the filters: `scope`
    // sets `botId`, and so does `q.botId`, so at the same object level the
    // caller's query param would simply overwrite the ownership restriction
    // instead of narrowing it — handing any user another tenant's live order
    // flow by passing ?botId=. Same key, last write wins.
    const filters: Prisma.TradeAuditWhereInput = {
      ...(q.jobId ? { jobId: q.jobId } : {}),
      ...(q.botId ? { botId: q.botId } : {}),
      ...(q.mode ? { mode: q.mode } : {}),
    };
    return prisma.tradeAudit.findMany({
      where: isAdmin(req) ? filters : { AND: [scope, filters] },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
  });

  app.get('/api/paper-trades', { preHandler: requireAuth('api') }, async (req) => {
    const q = PaperTradesQuery.parse(req.query);
    const where: Prisma.PaperTradeWhereInput = {};
    if (q.symbol) where.symbol = q.symbol;
    if (q.botId) {
      // botId on paper trade is via the originating job's bot
      const jobs = await prisma.job.findMany({ where: { botId: q.botId }, select: { id: true } });
      where.jobId = { in: jobs.map((j) => j.id) };
    }
    // PaperTrade has no owner column — it reaches a user only through its job.
    const allowed = await visibleJobIds(req);
    if (allowed) {
      where.jobId =
        where.jobId && typeof where.jobId === 'object' && 'in' in where.jobId
          ? { in: (where.jobId.in as string[]).filter((id) => allowed.includes(id)) }
          : { in: allowed };
    }
    return prisma.paperTrade.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
  });
}
