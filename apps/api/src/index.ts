import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './env.js';
import { loggerOptions } from './log.js';
import { registerHealth } from './health.js';
import { registerErrorHandler } from './errors.js';
import { templateRoutes } from './routes/templates.js';
import { botRoutes } from './routes/bots.js';
import { jobRoutes } from './routes/jobs.js';
import { workerRoutes } from './routes/workers.js';
import { sseRoutes } from './routes/sse.js';

const app = Fastify({ logger: loggerOptions });

app.register(cors, { origin: true, credentials: true });

registerErrorHandler(app);
registerHealth(app);
app.register(templateRoutes);
app.register(botRoutes);
app.register(jobRoutes);
app.register(workerRoutes);
app.register(sseRoutes);

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
