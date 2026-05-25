/**
 * "MCP Tool Tester" — opens an SSE connection to an MCP server, calls one
 * tool, returns the result. Useful for verifying that a Hive MCP Server is
 * exposing tools correctly without firing up Claude Desktop.
 */
import type { Handler } from '@hive/worker-base-ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

interface Config {
  mcpServerUrl: string;
  authToken?: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}

function parseConfig(raw: Record<string, unknown>): Config {
  const url = typeof raw.mcpServerUrl === 'string' ? raw.mcpServerUrl : '';
  if (!url) throw new Error('mcpServerUrl is required');
  const toolName = typeof raw.toolName === 'string' ? raw.toolName : '';
  if (!toolName) throw new Error('toolName is required');
  const toolArgs =
    raw.toolArgs && typeof raw.toolArgs === 'object' && !Array.isArray(raw.toolArgs)
      ? (raw.toolArgs as Record<string, unknown>)
      : {};
  const authToken = typeof raw.authToken === 'string' && raw.authToken.length > 0 ? raw.authToken : undefined;
  return { mcpServerUrl: url, authToken, toolName, toolArgs };
}

export const mcpToolTesterHandler: Handler = async (rawConfig, { log }) => {
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

  const client = new Client({ name: 'hive-mcp-tester', version: '0.1.0' });
  await client.connect(transport);
  await log.info('mcp.client.connected', { url: config.mcpServerUrl });

  try {
    const t0 = Date.now();
    const res = await client.callTool({ name: config.toolName, arguments: config.toolArgs });
    const latencyMs = Date.now() - t0;
    await log.info('mcp.tool.result', { tool: config.toolName, latencyMs, isError: !!res.isError });
    return {
      tool: config.toolName,
      latencyMs,
      isError: !!res.isError,
      content: res.content,
    };
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
};
