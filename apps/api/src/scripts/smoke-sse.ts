/**
 * SSE regression smoke — guards the bug fixed in 4bd5949.
 *
 *   pnpm --filter @hive/api smoke:sse
 *
 * Runs against a LIVE API (so the env / docker stack must be up). It:
 *   1. Picks a recent job (or fails loudly with how to seed one).
 *   2. GET /api/jobs/:id/stream with an Origin header.
 *   3. Asserts the response has Access-Control-Allow-Origin echoed back —
 *      the exact thing reply.raw.writeHead bypassed before the fix.
 *   4. Reads a few SSE frames to confirm the stream actually flows.
 *
 * Exits 0 on success, non-zero on any check failure. Suitable for CI / a
 * pre-commit hook once you have a stable test fixture.
 */
import { env } from '../env.js';

const API = `http://localhost:${env.API_PORT}`;
const ORIGIN = 'http://localhost:3001';

function fail(msg: string): never {
  console.error(`[smoke-sse] FAIL: ${msg}`);
  process.exit(1);
}

async function authHeader(): Promise<string> {
  // Use the static API_AUTH_TOKEN — same path the legacy bundle uses.
  // (Session-cookie path is covered by the in-browser Playwright run in
  // the UX pass; this script is the CI-friendly fallback.)
  return `Bearer ${env.API_AUTH_TOKEN}`;
}

async function pickJobId(): Promise<string> {
  const r = await fetch(`${API}/api/jobs?limit=5`, {
    headers: { Authorization: await authHeader() },
  });
  if (!r.ok) fail(`could not list jobs (HTTP ${r.status}). Is the API up?`);
  const jobs = (await r.json()) as Array<{ id: string }>;
  if (jobs.length === 0) {
    fail(
      'no jobs in the DB to test against. Seed one:\n' +
        "  curl -s -X POST 'http://localhost:4000/api/bots' -H \"Authorization: Bearer $API_AUTH_TOKEN\" \\\n" +
        '    -H \'Content-Type: application/json\' \\\n' +
        '    -d \'{"templateId":"<heartbeat-template-id>","name":"smoke","config":{"label":"x","payload":{}}}\'\n' +
        "  then POST /api/bots/<bot-id>/run.",
    );
  }
  return jobs[0].id;
}

async function main(): Promise<void> {
  const jobId = await pickJobId();
  console.log(`[smoke-sse] testing against job ${jobId}`);

  // Quick check: OPTIONS preflight returns 204 + ACAO (always worked, even
  // before the bug fix — but exercising it catches a broken cors plugin).
  const preflight = await fetch(`${API}/api/jobs/${jobId}/stream`, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  });
  if (preflight.status !== 204 && preflight.status !== 200) {
    fail(`preflight returned HTTP ${preflight.status} (want 204/200)`);
  }
  if (preflight.headers.get('access-control-allow-origin') !== ORIGIN) {
    fail(`preflight missing/wrong ACAO header: ${preflight.headers.get('access-control-allow-origin')}`);
  }
  console.log('[smoke-sse] OK preflight ACAO present');

  // The actual SSE GET — this is the case the bug broke.
  const ctrl = new AbortController();
  const res = await fetch(`${API}/api/jobs/${jobId}/stream`, {
    headers: {
      Origin: ORIGIN,
      Authorization: await authHeader(),
      Accept: 'text/event-stream',
    },
    signal: ctrl.signal,
  });
  if (!res.ok) fail(`SSE GET returned HTTP ${res.status}`);

  const acao = res.headers.get('access-control-allow-origin');
  const acac = res.headers.get('access-control-allow-credentials');
  if (acao !== ORIGIN) {
    fail(
      `SSE GET missing ACAO header (this is the bug fixed in 4bd5949).\n` +
        `  expected: ${ORIGIN}\n` +
        `  got:      ${acao ?? '(no header)'}\n` +
        `  full headers: ${JSON.stringify(Object.fromEntries(res.headers.entries()))}`,
    );
  }
  if (acac !== 'true') {
    fail(`SSE GET missing Access-Control-Allow-Credentials: true (got ${acac ?? '(no header)'})`);
  }
  console.log(`[smoke-sse] OK SSE GET ACAO=${acao} ACAC=${acac}`);

  // Read at least one frame to confirm the stream actually flows.
  if (!res.body) fail('SSE response has no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const timeout = setTimeout(() => ctrl.abort(), 5_000);
  let frames = 0;
  let buf = '';
  while (frames < 1) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    while (buf.includes('\n\n')) {
      const idx = buf.indexOf('\n\n');
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (frame.trim()) frames += 1;
    }
  }
  clearTimeout(timeout);
  try { ctrl.abort(); } catch { /* ignore */ }
  if (frames === 0) fail('SSE stream returned no frames within 5s');
  console.log(`[smoke-sse] OK stream produced ${frames}+ frame(s)`);

  console.log('[smoke-sse] all checks passed');
}

main().catch((e) => {
  console.error('[smoke-sse] unexpected error:', e);
  process.exit(1);
});
