# MCP host pool

The `mcp_host` pool runs MCP (Model Context Protocol) servers. Each "Hive MCP Server" bot is a long-lived job that exposes a hand-picked set of other Hive bots as MCP tools over SSE for a configurable duration.

| Template | Direction | Use |
|---|---|---|
| `Hive MCP Server`        | Hive → MCP client (Claude Desktop) | Expose Hive bots as tools |
| `MCP Tool Tester`        | Hive → external MCP server         | Call one tool on a running MCP server |
| `MCP Server Health Check`| Hive → external MCP server         | List tools + measure latency |

## Connecting Claude Desktop to a running Hive MCP Server

Start a "Hive MCP Server" bot (UI → Bots → New) — note the port from the job result (or, if you used `port: 0`, watch the joblog for `mcp.server.started`).

Then in your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS) add:

```json
{
  "mcpServers": {
    "hive": {
      "url": "http://localhost:PORT/sse"
    }
  }
}
```

If the bot was configured with an `authToken`, append it as a query param (Claude Desktop strips Authorization headers from custom URLs):

```json
{
  "mcpServers": {
    "hive": {
      "url": "http://localhost:PORT/sse?token=YOUR_TOKEN"
    }
  }
}
```

Restart Claude Desktop. The exposed bots show up as tools named after each bot (slugified, e.g. `cron_heartbeat`).

## Tool invocation flow

```
Claude → MCP server (worker process)
       → POST /api/bots/:id/run (with the tool args as overrideConfig)
       → poll GET /api/jobs/:id every 500ms (max 5min)
       → return result/error as the tool response
```

Each call is logged in the parent Hive MCP Server's joblog as `mcp.tool.invoked` (args are redacted for any property marked `x-secret: true` in the template's schema).

## Verifying without Claude Desktop

Use the "MCP Tool Tester" template to call a specific tool, or "MCP Server Health Check" to list tools:

```
MCP Tool Tester config:
  mcpServerUrl: http://localhost:PORT/sse
  authToken:    (only if your server requires one)
  toolName:     cron_heartbeat
  toolArgs:     { "label": "from-mcp" }
```

## Security

- The worker speaks plain HTTP — fine on localhost. **Do not expose the bound port without a reverse proxy that terminates TLS.**
- The `authToken` (marked `x-secret: true`) is the only access control. Pick a strong one and rotate when sharing.
- Args passed in tool calls become `overrideConfig` on `/api/bots/:id/run`, which means a Claude session can change any non-pinned field on the bot. If you don't want that, leave the field out of the bot's stored config so it has a default, or use a template that has fewer knobs.

## Limitations (Phase 4a)

- SSE only. `stdio` is not supported because the worker has no peer process on stdin/stdout. Pin to a known-good MCP SDK version (`1.29.0`) — the SDK is fast-moving.
- No streaming of intermediate results. Tool calls block until the underlying job reaches a terminal state, then return the final result in one chunk. Streaming is Phase 5.
- The worker converts the bot's JSON Schema into a coarser Zod shape for the MCP client (the SDK doesn't accept raw JSON Schema). The Hive API still validates against the full schema, so this is informational fidelity only.
