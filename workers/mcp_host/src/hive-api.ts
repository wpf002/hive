/**
 * Thin wrapper around the Hive HTTP API used by the mcp_host worker.
 *
 * mcp_host bots POST `/api/bots/:id/run` to invoke a Hive bot as an MCP tool
 * and then poll `/api/jobs/:id` until the job reaches a terminal state. The
 * worker uses API_AUTH_TOKEN (not WORKER_AUTH_TOKEN) because /api/bots/:id/run
 * is an `api` scope route.
 */
import { env } from './env.js';

interface BotSummary {
  id: string;
  name: string;
  config: Record<string, unknown>;
  template: {
    id: string;
    name: string;
    description: string | null;
    poolType: string;
    configSchema: unknown;
  };
}

interface JobSummary {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  result: unknown;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

const BASE = env.API_BASE_URL.replace(/\/$/, '');

function authHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${env.API_AUTH_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

export async function getBot(botId: string): Promise<BotSummary> {
  const r = await fetch(`${BASE}/api/bots/${botId}`, {
    method: 'GET',
    headers: authHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`getBot(${botId}) → ${r.status} ${text.slice(0, 200)}`);
  }
  return (await r.json()) as BotSummary;
}

export async function runBot(
  botId: string,
  overrideConfig?: Record<string, unknown>,
): Promise<JobSummary> {
  const r = await fetch(`${BASE}/api/bots/${botId}/run`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(overrideConfig ? { overrideConfig } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`runBot(${botId}) → ${r.status} ${text.slice(0, 200)}`);
  }
  return (await r.json()) as JobSummary;
}

export async function getJob(jobId: string): Promise<JobSummary> {
  const r = await fetch(`${BASE}/api/jobs/${jobId}`, {
    method: 'GET',
    headers: authHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`getJob(${jobId}) → ${r.status} ${text.slice(0, 200)}`);
  }
  return (await r.json()) as JobSummary;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** Poll a job to a terminal state with a hard wall-clock cap. */
export async function pollJob(jobId: string, maxMs: number = 5 * 60_000): Promise<JobSummary> {
  const start = Date.now();
  while (true) {
    const job = await getJob(jobId);
    if (TERMINAL.has(job.status)) return job;
    if (Date.now() - start > maxMs) {
      throw new Error(`pollJob(${jobId}) timeout after ${maxMs}ms; last status=${job.status}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export type { BotSummary, JobSummary };
