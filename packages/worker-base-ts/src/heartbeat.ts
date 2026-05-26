import { hostname as osHostname } from 'node:os';

export interface HeartbeatOptions {
  workerId: string;
  poolType: string;
  capacity: number;
  apiBaseUrl: string;
  authToken: string;
  getActiveJobs: () => number;
  getStatus?: () => 'online' | 'draining';
  hostname?: string;
  // Phase 5b: worker self-declared location for affinity-based routing.
  region?: string;
  zone?: string;
  intervalMs?: number;
}

const DEFAULT_INTERVAL = 10_000;

export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: Required<Omit<HeartbeatOptions, 'getStatus'>> & {
    getStatus?: () => 'online' | 'draining';
  };

  constructor(opts: HeartbeatOptions) {
    this.opts = {
      region: 'local',
      zone: 'default',
      ...opts,
      hostname: opts.hostname ?? osHostname(),
      intervalMs: opts.intervalMs ?? DEFAULT_INTERVAL,
    };
  }

  start(): void {
    if (this.timer) return;
    void this.send();
    this.timer = setInterval(() => void this.send(), this.opts.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.send();
  }

  private async send(): Promise<void> {
    const status = this.opts.getStatus?.() ?? 'online';
    try {
      await fetch(`${this.opts.apiBaseUrl.replace(/\/$/, '')}/api/workers/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.authToken}`,
        },
        body: JSON.stringify({
          workerId: this.opts.workerId,
          poolType: this.opts.poolType,
          hostname: this.opts.hostname,
          region: this.opts.region,
          zone: this.opts.zone,
          capacity: this.opts.capacity,
          activeJobs: this.opts.getActiveJobs(),
          metadata: { status, region: this.opts.region, zone: this.opts.zone },
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      /* heartbeat must not crash worker */
    }
  }
}
