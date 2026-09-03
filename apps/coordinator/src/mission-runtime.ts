import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { captureError } from '@hive/observability';
import { env } from './env.js';
import { runMissionLoop } from './loop.js';
import { runGathererBridge } from './gatherer/bridge.js';
import { runAnalystLoop, runAdversaryLoop } from './role-loops.js';

/**
 * Everything one running mission needs, started and stopped as a unit.
 *
 * Each loop that blocks on Redis gets its own connection: a blocking
 * XREADGROUP occupies a connection for the duration of its block, so sharing
 * one would serialize the roles behind whichever is currently waiting.
 *
 * The loops are peers rather than a pipeline. Nothing calls anything else —
 * they communicate only through the board, which is what lets a role be added
 * or removed without touching the others.
 */
export class MissionRuntime {
  private readonly controller = new AbortController();
  private readonly connections: Redis[] = [];
  private stopped = false;

  constructor(
    private readonly missionId: string,
    private readonly log: Logger,
  ) {}

  start(): void {
    const spawn = (name: string, fn: (r: Redis, s: AbortSignal) => Promise<void>) => {
      const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
      this.connections.push(redis);
      void fn(redis, this.controller.signal)
        .catch((err) => {
          // A role dying takes a capability off the board without stopping the
          // mission: it keeps running, quietly missing its analyst or its
          // adversary, and the console shows a mission that looks healthy and
          // never concludes anything. That has to reach someone.
          this.log.error({ err, missionId: this.missionId, role: name }, 'role loop crashed');
          captureError(err, {
            where: `mission-role:${name}`,
            extra: { missionId: this.missionId },
          });
        })
        .finally(() => {
          try { redis.disconnect(); } catch { /* already gone */ }
        });
    };

    spawn('gatherer', (r, s) => runGathererBridge(this.missionId, r, s, this.log));
    spawn('analyst', (r, s) => runAnalystLoop(this.missionId, r, s, this.log));
    spawn('adversary', (r, s) => runAdversaryLoop(this.missionId, r, s, this.log));
    spawn('coordinator', (r, s) => runMissionLoop(this.missionId, r, s, this.log));

    this.log.info({ missionId: this.missionId }, 'mission runtime started');
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
    this.log.info({ missionId: this.missionId }, 'mission runtime stopping');
  }
}
