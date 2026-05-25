import type { FastifyRequest } from 'fastify';
import { prisma, Prisma } from '@hive/db';

export async function writeAuditLog(
  req: FastifyRequest,
  args: {
    userId?: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const ipAddress = req.ip;
  try {
    await prisma.auditLog.create({
      data: {
        userId: args.userId ?? null,
        action: args.action,
        targetType: args.targetType,
        targetId: args.targetId,
        payload: (args.payload ?? null) as Prisma.InputJsonValue,
        ipAddress,
      },
    });
  } catch (err) {
    req.log.warn({ err, action: args.action }, 'audit_log_write_failed');
  }
}
