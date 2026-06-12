/**
 * "Hive MCP Server" template — long-running job that exposes a set of Hive
 * bots as MCP tools over SSE for a fixed duration.
 *
 * Each exposed bot becomes one MCP tool. Calling the tool POSTs `/api/bots/:id/run`
 * with the call's args as overrideConfig and polls until the job finishes.
 * Failed jobs surface as MCP tool errors (isError: true).
 */
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { Handler } from '@hive/worker-base-ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { getBot, runBot, pollJob, type BotSummary } from '../hive-api.js';

interface SchemaProp {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  properties?: Record<string, SchemaProp>;
  items?: SchemaProp;
  required?: string[];
  additionalProperties?: boolean | SchemaProp;
  ['x-secret']?: boolean;
}

interface JsonSchemaObject extends SchemaProp {
  type?: 'object';
  properties?: Record<string, SchemaProp>;
  required?: string[];
}

function slugifyToolName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'tool'
  );
}

function isObjectSchema(s: unknown): s is JsonSchemaObject {
  return !!s && typeof s === 'object' && (s as JsonSchemaObject).type === 'object';
}

/** JSON Schema for tool args = template.configSchema minus props already pinned in bot.config. */
function buildToolInputSchema(template: BotSummary['template'], pinned: Record<string, unknown>): JsonSchemaObject {
  const base = template.configSchema;
  if (!isObjectSchema(base)) return { type: 'object', properties: {} };
  const props = { ...(base.properties ?? {}) };
  const required = (base.required ?? []).filter((k) => !(k in pinned));
  for (const k of Object.keys(pinned)) delete props[k];
  return {
    type: 'object',
    properties: props,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/** Lossy JSON-Schema → Zod shape. The SDK requires a ZodRawShape for tool args;
 * we still hand the *real* JSON Schema down to /api/bots/:id/run which validates
 * with full fidelity, so the worst case here is that the MCP client sees a
 * looser schema than the bot template enforces. */
function jsonSchemaToZodShape(schema: JsonSchemaObject): Record<string, z.ZodTypeAny> {
  const out: Record<string, z.ZodTypeAny> = {};
  const required = new Set(schema.required ?? []);
  for (const [k, prop] of Object.entries(schema.properties ?? {})) {
    const t = Array.isArray(prop.type) ? prop.type[0] : prop.type;
    let zodType: z.ZodTypeAny;
    switch (t) {
      case 'string':
        zodType = z.string();
        break;
      case 'number':
        zodType = z.number();
        break;
      case 'integer':
        zodType = z.number().int();
        break;
      case 'boolean':
        zodType = z.boolean();
        break;
      case 'array':
        zodType = z.array(z.unknown());
        break;
      case 'object':
        zodType = z.record(z.unknown());
        break;
      default:
        zodType = z.unknown();
    }
    if (prop.description) zodType = zodType.describe(prop.description);
    out[k] = required.has(k) ? zodType : zodType.optional();
  }
  return out;
}

function collectSecretPaths(schema: unknown, prefix = ''): string[] {
  const out: string[] = [];
  if (!schema || typeof schema !== 'object') return out;
  const s = schema as SchemaProp;
  if (s['x-secret'] === true) {
    out.push(prefix);
    return out;
  }
  if (s.properties) {
    for (const [k, child] of Object.entries(s.properties)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.push(...collectSecretPaths(child, p));
    }
  }
  if (s.items) out.push(...collectSecretPaths(s.items, prefix));
  return out;
}

function redactArgs(args: Record<string, unknown>, secretPaths: string[]): Record<string, unknown> {
  if (secretPaths.length === 0) return args;
  const out = structuredClone(args);
  for (const path of secretPaths) {
    const parts = path.split('.');
    let cursor: Record<string, unknown> | null = out as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const next = cursor?.[parts[i]];
      if (next && typeof next === 'object' && !Array.isArray(next)) {
        cursor = next as Record<string, unknown>;
      } else {
        cursor = null;
        break;
      }
    }
    const key = parts[parts.length - 1];
    if (cursor && key in cursor) cursor[key] = '****redacted';
  }
  return out;
}

interface Config {
  durationSeconds: number;
  port: number;
  exposedBots: string[];
  transportMode: 'sse' | 'stdio';
  authToken?: string;
}

function parseConfig(raw: Record<string, unknown>): Config {
  const exposedBots = Array.isArray(raw.exposedBots)
    ? (raw.exposedBots as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  if (exposedBots.length === 0) {
    throw new Error('exposedBots is required and must contain at least one bot id');
  }
  const transportMode = raw.transportMode === 'stdio' ? 'stdio' : 'sse';
  const durationSeconds = Math.min(86400, Number(raw.durationSeconds ?? 3600));
  const port = Number.isFinite(Number(raw.port)) ? Number(raw.port) : 0;
  const authToken =
    typeof raw.authToken === 'string' && raw.authToken.length > 0 ? raw.authToken : undefined;
  return { durationSeconds, port: port || 0, exposedBots, transportMode, authToken };
}

export const hiveMcpServerHandler: Handler = async (rawConfig, { log }) => {
  const config = parseConfig(rawConfig);
  if (config.transportMode === 'stdio') {
    throw new Error("transportMode='stdio' is not supported by the worker process (worker has no stdio peer). Use 'sse'.");
  }

  // Resolve exposed bots up front so we fail fast on bad ids.
  const bots: BotSummary[] = [];
  for (const id of config.exposedBots) {
    bots.push(await getBot(id));
  }

  let toolCallCount = 0;

  // Build a FRESH McpServer per SSE connection. The SDK's Server (Protocol)
  // only supports ONE transport at a time, so sharing a single instance makes
  // a 2nd concurrent client's connect() throw "Already connected to a
  // transport" — its response never gets headers and the client hangs until a
  // Headers Timeout. A new instance per connection lets concurrent clients in.
  function buildServer(): McpServer {
    const server = new McpServer({ name: 'hive-mcp', version: '0.1.0' });

    for (const bot of bots) {
    const toolName = slugifyToolName(bot.name);
    const description = bot.template.description ?? `Invoke Hive bot "${bot.name}"`;
    const jsonInputSchema = buildToolInputSchema(bot.template, bot.config);
    const zodShape = jsonSchemaToZodShape(jsonInputSchema);
    const secretPaths = collectSecretPaths(jsonInputSchema);

    server.registerTool(
      toolName,
      {
        description,
        inputSchema: zodShape,
      },
      async (args: Record<string, unknown>) => {
        toolCallCount += 1;
        await log.info('mcp.tool.invoked', {
          tool: toolName,
          botId: bot.id,
          args: redactArgs(args ?? {}, secretPaths),
        });
        try {
          const job = await runBot(bot.id, args ?? {});
          const terminal = await pollJob(job.id);
          if (terminal.status === 'succeeded') {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    { status: 'succeeded', jobId: terminal.id, result: terminal.result },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  { status: terminal.status, jobId: terminal.id, error: terminal.error },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await log.error('mcp.tool.error', { tool: toolName, botId: bot.id, error: msg });
          return { isError: true, content: [{ type: 'text' as const, text: msg }] };
        }
      },
    );
    }

    return server;
  }

  const transports = new Map<string, SSEServerTransport>();

  function checkAuth(req: IncomingMessage): boolean {
    if (!config.authToken) return true;
    const auth = req.headers.authorization;
    if (auth && typeof auth === 'string') {
      const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
      if (m && m[1] === config.authToken) return true;
    }
    const url = new URL(req.url ?? '/', 'http://placeholder');
    return url.searchParams.get('token') === config.authToken;
  }

  const http = createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(400).end('missing url');
      return;
    }
    const url = new URL(req.url, 'http://placeholder');

    if (!checkAuth(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="hive-mcp"' }).end('unauthorized');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', res);
      transports.set(transport.sessionId, transport);
      // One server instance per connection (see buildServer) so concurrent
      // clients don't collide on a single shared Protocol. We don't call
      // connServer.close() here — the transport is already closing, and
      // closing the server would re-close the transport and recurse. Dropping
      // the map ref is enough; the per-connection server is then GC'd.
      const connServer = buildServer();
      transport.onclose = () => {
        transports.delete(transport.sessionId);
      };
      try {
        await connServer.connect(transport);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await log.error('mcp.connect_failed', { error: msg });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        res.writeHead(400).end('missing sessionId');
        return;
      }
      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404).end('unknown session');
        return;
      }
      try {
        await transport.handlePostMessage(req, res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) res.writeHead(500).end(msg);
      }
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          ok: true,
          service: 'hive-mcp',
          tools: bots.map((b) => slugifyToolName(b.name)),
          sessions: transports.size,
          toolCallCount,
        }),
      );
      return;
    }

    res.writeHead(404).end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.port, '0.0.0.0', () => resolve());
  });
  const bound = http.address() as AddressInfo;
  const boundPort = bound.port;
  const exitedAt = new Date(Date.now() + config.durationSeconds * 1000);

  await log.info('mcp.server.started', {
    port: boundPort,
    transport: config.transportMode,
    exposedBotIds: bots.map((b) => b.id),
    tools: bots.map((b) => slugifyToolName(b.name)),
    durationSeconds: config.durationSeconds,
    authRequired: !!config.authToken,
  });

  await new Promise((resolve) => setTimeout(resolve, config.durationSeconds * 1000));

  for (const t of transports.values()) {
    try { await t.close(); } catch { /* ignore */ }
  }
  transports.clear();
  await new Promise<void>((resolve) => http.close(() => resolve()));

  await log.info('mcp.server.exited', { port: boundPort, toolCallCount });

  return {
    exposedBots: bots.map((b) => ({ id: b.id, tool: slugifyToolName(b.name) })),
    port: boundPort,
    transportMode: config.transportMode,
    toolCallCount,
    exitedAt: exitedAt.toISOString(),
  };
};
