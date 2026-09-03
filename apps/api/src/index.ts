import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { env } from './env.js';
import { loggerOptions } from './log.js';
import { registerHealth } from './health.js';
import { registerErrorHandler } from './errors.js';
import { templateRoutes } from './routes/templates.js';
import { botRoutes } from './routes/bots.js';
import { botBuilderRoutes } from './routes/bot-builder.js';
import { reportRoutes } from './routes/reports.js';
import { jobRoutes } from './routes/jobs.js';
import { workerRoutes } from './routes/workers.js';
import { sseRoutes } from './routes/sse.js';
import { scheduleRoutes } from './routes/schedules.js';
import { tradingRoutes } from './routes/trading.js';
import { authRoutes } from './routes/auth.js';
import { artifactRoutes } from './routes/artifacts.js';
import { statusRoutes } from './routes/status.js';
import { alertRoutes } from './routes/alerts.js';
import { onboardingRoutes } from './routes/onboarding.js';
import { missionRoutes } from './routes/missions.js';
import { missionStreamRoutes } from './routes/mission-stream.js';
import { missionComposeRoutes } from './routes/mission-compose.js';
import { initStorage } from './lib/artifacts.js';
import { isOriginAllowed } from './lib/cors.js';
import { initObservability } from '@hive/observability';

await initStorage();

const app = Fastify({ logger: loggerOptions });

// CORS allows credentials so the browser sends session cookies on /api/*.
// Because credentials are allowed we must validate the Origin against an
// allowlist rather than reflecting it — reflecting any origin would let any
// website issue authenticated requests and read the responses.
app.register(cors, {
  origin: (origin, cb) => {
    if (isOriginAllowed(origin ?? undefined)) return cb(null, true);
    cb(null, false);
  },
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
app.register(botBuilderRoutes);
app.register(reportRoutes);
app.register(jobRoutes);
app.register(workerRoutes);
app.register(sseRoutes);
app.register(scheduleRoutes);
app.register(tradingRoutes);
app.register(artifactRoutes);
app.register(statusRoutes);
app.register(alertRoutes);
app.register(onboardingRoutes);
app.register(missionRoutes);
app.register(missionStreamRoutes);
app.register(missionComposeRoutes);

try {
  // Honor the platform-injected $PORT (Railway, Heroku, etc.); fall back to the
  // configured API_PORT (Fly sets PORT=4000 which matches the default anyway).
  const port = process.env.PORT ? Number(process.env.PORT) : env.API_PORT;
  // Fatal handlers before the port opens: a process that starts serving and
  // then dies to an unhandled rejection with no log line is the failure this
  // guards. Reporting itself is optional (SENTRY_DSN); the handlers are not.
  await initObservability({
    service: 'api',
    dsn: process.env.SENTRY_DSN,
    release: process.env.HIVE_RELEASE,
    logger: app.log,
    onFatal: () => app.close(),
  });

  await app.listen({ port, host: '0.0.0.0' });
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
