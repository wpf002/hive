export type Pool =
  | 'browser' | 'scraper' | 'rpa_desktop' | 'discord' | 'telegram'
  | 'trading' | 'monitor' | 'mcp_host' | 'ci_agent' | 'task_runner' | 'ai_agent';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface BotTemplate {
  id: string;
  name: string;
  description: string | null;
  poolType: Pool;
  configSchema: Record<string, unknown>;
  defaultConfig: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Bot {
  id: string;
  templateId: string;
  template?: BotTemplate;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  jobs?: Job[];
}

export interface Job {
  id: string;
  botId: string;
  bot?: Bot;
  status: JobStatus;
  priority: number;
  payload: Record<string, unknown>;
  result: unknown | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  logs?: JobLog[];
}

export interface JobLog {
  id: string;
  jobId: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta: Record<string, unknown> | null;
  timestamp: string;
}

export interface Worker {
  id: string;
  poolType: Pool;
  hostname: string;
  status: 'online' | 'offline' | 'draining';
  capacity: number;
  activeJobs: number;
  lastSeenAt: string;
  metadata: Record<string, unknown> | null;
}

export interface HealthCheck {
  status: 'ok' | 'degraded';
  service: string;
  uptimeMs: number;
  checks: Record<string, { ok: boolean; error?: string }>;
}

export interface Schedule {
  id: string;
  botId: string;
  bot?: Bot;
  cron: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface AiUsage {
  id: string;
  jobId: string | null;
  provider: 'claude' | 'gpt' | 'perplexity';
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  createdAt: string;
}
