import { WorkerBase } from '@hive/worker-base-ts';
import { env } from './env.js';
import { hiveMcpServerHandler } from './handlers/hiveMcpServer.js';
import { mcpToolTesterHandler } from './handlers/mcpToolTester.js';
import { mcpHealthCheckHandler } from './handlers/mcpHealthCheck.js';

export const HIVE_MCP_SERVER = 'Hive MCP Server';
export const MCP_TOOL_TESTER = 'MCP Tool Tester';
export const MCP_HEALTH_CHECK = 'MCP Server Health Check';

class McpHostWorker extends WorkerBase {
  constructor() {
    super({
      // capacity=8 — each MCP server is long-running but idle most of the time
      poolType: 'mcp_host',
      capacity: 8,
      maxAttempts: 1, // never auto-retry a long-running MCP server
      apiBaseUrl: env.API_BASE_URL,
      workerAuthToken: env.WORKER_AUTH_TOKEN,
      redisUrl: env.REDIS_URL,
    });
  }

  protected async setup(): Promise<void> {
    this.register(HIVE_MCP_SERVER, hiveMcpServerHandler);
    this.register(MCP_TOOL_TESTER, mcpToolTesterHandler);
    this.register(MCP_HEALTH_CHECK, mcpHealthCheckHandler);
  }
}

await new McpHostWorker().run();
