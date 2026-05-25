/**
 * "MCP Server Health Check" — connects to an MCP server, lists tools,
 * reports latency and whether expected tools are present.
 */
import type { Handler } from '@hive/worker-base-ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

interface Config {
  mcpServerUrl: string;
  authToken?: string;
  expectedTools: string[];
}

function parseConfig(raw: Record<string, unknown>): Config {
  const url = typeof raw.mcpServerUrl === 'string' ? raw.mcpServerUrl : '';
  if (!url) throw new Error('mcpServerUrl is required');
  const expectedTools = Array.isArray(raw.expectedTools)
    ? (raw.expectedTools as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const authToken = typeof raw.authToken === 'string' && raw.authToken.length > 0 ? raw.authToken : undefined;
  return { mcpServerUrl: url, authToken, expectedTools };
}

export const mcpHealthCheckHandler: Handler = async (rawConfig, { log }) => {
  const config = parseConfig(rawConfig);

  const transport = new SSEClientTransport(new URL(config.mcpServerUrl), {
    requestInit: config.authToken
      ? { headers: { Authorization: `Bearer ${config.authToken}` } }
      : undefined,
    eventSourceInit: config.authToken
      ? {
          fetch: (url, init) =>
            fetch(url, {
              ...(init ?? {}),
              headers: { ...((init?.headers as Record<string, string>) ?? {}), Authorization: `Bearer ${config.authToken}` },
            }),
        }
      : undefined,
  });
  const client = new Client({ name: 'hive-mcp-healthcheck', version: '0.1.0' });

  const t0 = Date.now();
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const latencyMs = Date.now() - t0;
    const names = tools.tools.map((t) => t.name);
    const allExpectedFound = config.expectedTools.length === 0 || config.expectedTools.every((t) => names.includes(t));
    const missing = config.expectedTools.filter((t) => !names.includes(t));
    await log.info('mcp.health.ok', {
      latencyMs,
      toolCount: names.length,
      allExpectedFound,
      missing,
    });
    return {
      tools: names,
      allExpectedFound,
      missing,
      latencyMs,
    };
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
};
