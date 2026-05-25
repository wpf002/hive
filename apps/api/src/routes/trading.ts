import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, Prisma } from '@hive/db';
import { requireAuth, requireRole } from '../auth.js';
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

  app.get('/api/paper-wallet', { preHandler: requireAuth('api') }, async () => {
    return prisma.paperWallet.findMany({
      orderBy: [{ exchange: 'asc' }, { currency: 'asc' }],
    });
  });

  app.get('/api/trade-audit', { preHandler: requireAuth('api') }, async (req) => {
    const q = AuditQuery.parse(req.query);
    return prisma.tradeAudit.findMany({
      where: {
        jobId: q.jobId,
        botId: q.botId,
        mode: q.mode,
      },
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
    return prisma.paperTrade.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
  });
}
