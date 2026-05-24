import { Redis } from 'ioredis';
import { prisma, Prisma } from '@hive/db';
import { STREAMS } from './lifecycle.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
  meta?: Record<string, unknown> | null;
}

const FLUSH_BATCH = 50;

interface BufferedRow {
  jobId: string;
  level: LogLevel;
  message: string;
  meta: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  timestamp: Date;
}

export class JobLogger {
  private readonly jobId: string;
  private readonly redis: Redis;
  private readonly channel: string;
  private readonly batchSize: number;
  private buffer: BufferedRow[] = [];
  private flushing = false;

  constructor(jobId: string, redis: Redis, batchSize: number = FLUSH_BATCH) {
    this.jobId = jobId;
    this.redis = redis;
    this.channel = STREAMS.logs(jobId);
    this.batchSize = batchSize;
  }

  async info(message: string, meta?: Record<string, unknown>): Promise<void> {
    await this.emit('info', message, meta);
  }
  async warn(message: string, meta?: Record<string, unknown>): Promise<void> {
    await this.emit('warn', message, meta);
  }
  async error(message: string, meta?: Record<string, unknown>): Promise<void> {
    await this.emit('error', message, meta);
  }
  async debug(message: string, meta?: Record<string, unknown>): Promise<void> {
    await this.emit('debug', message, meta);
  }

  private async emit(level: LogLevel, message: string, meta?: Record<string, unknown>): Promise<void> {
    const ts = new Date();
    const payload: LogEntry = {
      ts: ts.toISOString(),
      level,
      message,
      meta: meta ?? null,
    };
    try {
      await this.redis.publish(this.channel, JSON.stringify(payload));
    } catch {
      /* live logs are best-effort */
    }
    this.buffer.push({
      jobId: this.jobId,
      level,
      message,
      meta: (meta ?? Prisma.JsonNull) as Prisma.InputJsonValue | typeof Prisma.JsonNull,
      timestamp: ts,
    });
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const rows = this.buffer;
    this.buffer = [];
    try {
      await prisma.jobLog.createMany({ data: rows });
    } catch (err) {
      this.buffer = rows.concat(this.buffer).slice(0, 1000);
      throw err;
    } finally {
      this.flushing = false;
    }
  }

  async signalTerminal(status: 'succeeded' | 'failed' | 'cancelled'): Promise<void> {
    try {
      await this.redis.publish(this.channel, JSON.stringify({ __terminal: true, status }));
    } catch {
      /* ignore */
    }
  }
}
