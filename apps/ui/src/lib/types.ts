export type Pool =
  | 'browser' | 'scraper' | 'rpa_desktop' | 'discord' | 'telegram'
  | 'trading' | 'monitor' | 'mcp_host' | 'ci_agent' | 'task_runner' | 'ai_agent';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unroutable';

/** Phase 5b: optional dispatch-time placement on a template or bot. */
export interface Affinity {
  region?: string | null;
  zone?: string | null;
}

export interface BotTemplate {
  id: string;
  name: string;
  description: string | null;
  poolType: Pool;
  configSchema: Record<string, unknown>;
  defaultConfig: Record<string, unknown>;
  affinity: Affinity | null;
  createdAt: string;
  updatedAt: string;
}

export interface Bot {
  id: string;
  templateId: string;
  template?: BotTemplate;
  name: string;
  config: Record<string, unknown>;
  affinityOverride: Affinity | null;
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
  attempts: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
  result: unknown | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  logs?: JobLog[];
}

export interface DlqEntry {
  entryId: string;
  jobId: string;
  botId: string;
  pool: string;
  templateName: string;
  error: string;
  failedAt: string;
  workerId: string;
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
  region: string;
  zone: string;
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

export interface PaperWallet {
  id: string;
  exchange: string;
  currency: string;
  balance: string;
  botId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaperTrade {
  id: string;
  jobId: string;
  exchange: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  amount: string;
  price: string | null;
  status: 'filled' | 'cancelled' | 'failed';
  executedPrice: string | null;
  createdAt: string;
}

export interface TradeAudit {
  id: string;
  jobId: string;
  botId: string;
  mode: 'paper' | 'live';
  action: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  createdAt: string;
}

export interface SysInfo {
  tradingLiveEnabled: boolean;
  signupsEnabled: boolean;
  nodeEnv: string;
  envLabel: string | null;
}
