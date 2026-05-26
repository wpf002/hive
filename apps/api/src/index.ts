import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { env } from './env.js';
import { loggerOptions } from './log.js';
import { registerHealth } from './health.js';
import { registerErrorHandler } from './errors.js';
import { templateRoutes } from './routes/templates.js';
import { botRoutes } from './routes/bots.js';
import { jobRoutes } from './routes/jobs.js';
import { workerRoutes } from './routes/workers.js';
import { sseRoutes } from './routes/sse.js';
import { scheduleRoutes } from './routes/schedules.js';
import { aiRoutes } from './routes/ai.js';
import { tradingRoutes } from './routes/trading.js';
import { authRoutes } from './routes/auth.js';
import { artifactRoutes } from './routes/artifacts.js';
import { initStorage } from './lib/artifacts.js';

await initStorage();

const app = Fastify({ logger: loggerOptions });

// CORS must allow credentials so the browser sends session cookies on /api/*.
app.register(cors, {
  origin: (_origin, cb) => cb(null, true),
  credentials: true,
});
app.register(cookie);

// Workers POST raw image/PNG, etc. bodies to /api/jobs/:id/artifacts. Fastify's
// default parser only knows JSON + urlencoded; we register a binary parser so
// the route receives a Buffer.
app.addContentTypeParser(
  ['application/octet-stream', 'image/png', 'image/jpeg', 'application/zip', 'text/html'],
  { parseAs: 'buffer' },
  (_req, body, done) => done(null, body),
);

registerErrorHandler(app);
registerHealth(app);
app.register(authRoutes);
app.register(templateRoutes);
app.register(botRoutes);
app.register(jobRoutes);
app.register(workerRoutes);
app.register(sseRoutes);
app.register(scheduleRoutes);
app.register(aiRoutes);
app.register(tradingRoutes);
app.register(artifactRoutes);

try {
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error({ err }, 'failed_to_start');
  process.exit(1);
}

const shutdown = async (sig: string) => {
  app.log.info({ sig }, 'shutdown');
  try { await app.close(); } catch (e) { app.log.error({ err: e }, 'close_failed'); }
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
