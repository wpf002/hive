import { prisma, Prisma } from '@hive/db';

export async function writeAudit(args: {
  jobId: string;
  botId: string;
  mode: 'paper' | 'live';
  action: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
}): Promise<void> {
  await prisma.tradeAudit.create({
    data: {
      jobId: args.jobId,
      botId: args.botId,
      mode: args.mode,
      action: args.action,
      payload: args.payload as Prisma.InputJsonValue,
      result: args.result as Prisma.InputJsonValue,
    },
  });
}
