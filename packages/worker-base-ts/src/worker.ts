import { hostname as osHostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { JobLogger } from './joblog.js';
import { Heartbeat } from './heartbeat.js';
import {
  DLQ_STREAM,
  POOL_GROUP,
  poolStream,
  drainKey,
  markRunning,
  markSucceeded,
  markFailed,
  incrementAttempts,
} from './lifecycle.js';

export interface JobFields {
  jobId: string;
  botId: string;
  pool: string;
  templateName: string;
  config: string;
  priority: string;
}

export type Handler = (config: Record<string, unknown>, ctx: HandlerContext) => Promise<unknown>;

export interface HandlerContext {
  jobId: string;
  botId: string;
  log: JobLogger;
}

export interface WorkerOptions {
  poolType: string;
  capacity?: number;
  maxAttempts?: number;
  apiBaseUrl: string;
  workerAuthToken: string;
  redisUrl: string;
}

export abstract class WorkerBase {
  protected readonly opts: Required<WorkerOptions>;
  readonly workerId: string;
  protected redisMain!: Redis;
  protected redisBlock!: Redis;
  protected heartbeat!: Heartbeat;
  private readonly handlers = new Map<string, Handler>();
  private activeJobs = 0;
  private status: 'online' | 'draining' = 'online';
  private shouldExit = false;

  constructor(opts: WorkerOptions) {
    this.opts = {
      capacity: 4,
      maxAttempts: 3,
      ...opts,
    };
    this.workerId = `${opts.poolType}-${osHostname()}-${randomUUID().slice(0, 8)}`;
  }

  register(templateName: string, handler: Handler): void {
    this.handlers.set(templateName, handler);
  }

  protected abstract setup(): Promise<void>;

  get stream(): string {
    return poolStream(this.opts.poolType);
  }

  get group(): string {
    return POOL_GROUP(this.opts.poolType);
  }

  async run(): Promise<void> {
    await this.setup();
    if (this.handlers.size === 0) {
      throw new Error(`${this.constructor.name}.setup() did not register any handlers`);
    }

    this.redisMain = new Redis(this.opts.redisUrl, { lazyConnect: false });
    this.redisBlock = new Redis(this.opts.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });

    await this.ensureGroup();

    this.heartbeat = new Heartbeat({
      workerId: this.workerId,
      poolType: this.opts.poolType,
      capacity: this.opts.capacity,
      apiBaseUrl: this.opts.apiBaseUrl,
      authToken: this.opts.workerAuthToken,
      getActiveJobs: () => this.activeJobs,
      getStatus: () => this.status,
    });
    this.heartbeat.start();

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      service: `worker-${this.opts.poolType}`,
      event: 'worker.start',
      workerId: this.workerId,
      capacity: this.opts.capacity,
    }));

    const shutdown = async (sig: string) => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'worker.signal', sig }));
      this.shouldExit = true;
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    try {
      await this.consumeLoop();
    } finally {
      await this.heartbeat.stop();
      try { this.redisMain.disconnect(); } catch { /* noop */ }
      try { this.redisBlock.disconnect(); } catch { /* noop */ }
    }
  }

  private async ensureGroup(): Promise<void> {
    try {
      await this.redisMain.xgroup('CREATE', this.stream, this.group, '$', 'MKSTREAM');
    } catch (err) {
      if (err instanceof Error && err.message.includes('BUSYGROUP')) return;
      throw err;
    }
  }

  private async checkDrain(): Promise<boolean> {
    const val = await this.redisMain.get(drainKey(this.workerId));
    return val === '1';
  }

  private async consumeLoop(): Promise<void> {
    while (!this.shouldExit) {
      if (await this.checkDrain()) {
        if (this.status !== 'draining') {
          this.status = 'draining';
          console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'worker.draining', workerId: this.workerId }));
        }
        if (this.activeJobs === 0) {
          console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'worker.drained_exit', workerId: this.workerId }));
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      if (this.activeJobs >= this.opts.capacity) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }

      const slots = this.opts.capacity - this.activeJobs;
      const res = (await this.redisBlock.xreadgroup(
        'GROUP', this.group, this.workerId,
        'COUNT', slots,
        'BLOCK', 5000,
        'STREAMS', this.stream, '>',
      )) as Array<[string, Array<[string, string[]]>]> | null;
      if (!res) continue;
      for (const [, entries] of res) {
        for (const [entryId, fields] of entries) {
          const map: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) map[fields[i]] = fields[i + 1];
          void this.process(entryId, map as unknown as JobFields);
        }
      }
    }
  }

  private async process(entryId: string, fields: JobFields): Promise<void> {
    this.activeJobs += 1;
    const { jobId, botId, templateName } = fields;
    const log = new JobLogger(jobId, this.redisMain);
    let parsedConfig: Record<string, unknown> = {};
    try {
      parsedConfig = JSON.parse(fields.config ?? '{}');
    } catch { /* keep empty */ }

    const handler = this.handlers.get(templateName);
    if (!handler) {
      await log.error('unknown_template', { template: templateName });
      await markFailed(jobId, `no handler for template '${templateName}'`);
      await log.flush();
      await log.signalTerminal('failed');
      await this.ack(entryId, jobId);
      return;
    }

    await markRunning(jobId);
    await log.info('job.start', { template: templateName, worker: this.workerId });

    let lastError: string | null = null;
    let succeededResult: unknown = null;
    let didSucceed = false;

    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt += 1) {
      if (attempt > 1) {
        await incrementAttempts(jobId);
        await log.warn('job.retrying', { attempt });
      } else {
        await incrementAttempts(jobId);
      }
      try {
        succeededResult = await handler(parsedConfig, { jobId, botId, log });
        didSucceed = true;
        break;
      } catch (err) {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        lastError = msg;
        const stack = err instanceof Error ? err.stack?.split('\n').slice(0, 8).join('\n') : undefined;
        await log.error('job.error', { attempt, error: msg, stack });
      }
    }

    if (didSucceed) {
      await markSucceeded(jobId, succeededResult);
      await log.info('job.succeeded');
      await log.flush();
      await log.signalTerminal('succeeded');
    } else {
      await markFailed(jobId, lastError ?? 'unknown error');
      await log.error('job.dead_letter', { maxAttempts: this.opts.maxAttempts });
      await log.flush();
      try {
        await this.redisMain.xadd(
          DLQ_STREAM, '*',
          'jobId', jobId,
          'botId', botId,
          'pool', this.opts.poolType,
          'templateName', templateName,
          'config', fields.config ?? '{}',
          'error', lastError ?? 'unknown error',
          'failedAt', new Date().toISOString(),
          'workerId', this.workerId,
        );
      } catch (err) {
        console.error('dlq_xadd_failed', err);
      }
      await log.signalTerminal('failed');
    }
    await this.ack(entryId, jobId);
  }

  private async ack(entryId: string, jobId: string): Promise<void> {
    this.activeJobs -= 1;
    try {
      await this.redisMain.xack(this.stream, this.group, entryId);
    } catch (err) {
      console.error('xack_failed', { jobId, entryId, err });
    }
  }
}
