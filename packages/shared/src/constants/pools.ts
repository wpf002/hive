export const WORKER_POOLS = [
  'browser',
  'scraper',
  'rpa_desktop',
  'trading',
  'monitor',
  'mcp_host',
  'ci_agent',
  'task_runner',
  'ai_agent',
] as const;

export type WorkerPool = (typeof WORKER_POOLS)[number];

export const POOL_LABELS: Record<WorkerPool, string> = {
  browser: 'Browser',
  scraper: 'Scraper',
  rpa_desktop: 'Desktop RPA',
  trading: 'Trading',
  monitor: 'Monitor',
  mcp_host: 'MCP Host',
  ci_agent: 'CI Agent',
  task_runner: 'Task Runner',
  ai_agent: 'AI Agent',
};
