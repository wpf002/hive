import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@hive/db';
import { verifyLocalPresign } from '@hive/storage';
import { requireAuth } from '../auth.js';
import {
  openArtifactStream,
  presignArtifactGet,
  saveArtifact,
  getStorageProvider,
} from '../lib/artifacts.js';
import { env } from '../env.js';

const UploadQuery = z.object({
  filename: z.string().min(1),
  contentType: z.string().optional(),
});

const PresignQuery = z.object({
  ttl: z.coerce.number().int().positive().max(3600).default(300),
});

export async function artifactRoutes(app: FastifyInstance) {
  // ===== Upload (worker scope only) =====
  // Workers POST raw bytes; query params carry filename + contentType.
  // Cap at 64 MiB to keep blast radius small.
  app.post<{ Params: { id: string } }>(
    '/api/jobs/:id/artifacts',
    {
      preHandler: requireAuth('worker'),
      bodyLimit: 64 * 1024 * 1024,
    },
    async (req, reply) => {
      const q = UploadQuery.parse(req.query);
      const job = await prisma.job.findUnique({ where: { id: req.params.id } });
      if (!job) return reply.code(404).send({ error: { code: 'not_found', message: 'job not found' } });

      const body = req.body;
      const buf = Buffer.isBuffer(body)
        ? body
        : typeof body === 'string'
          ? Buffer.from(body, 'binary')
          : null;
      if (!buf || buf.length === 0) {
        return reply.code(400).send({ error: { code: 'empty_body', message: 'request body is empty' } });
      }
      const contentType = q.contentType ?? req.headers['content-type'] ?? 'application/octet-stream';
      const result = await saveArtifact(job.id, q.filename, buf, String(contentType));
      return reply.code(201).send({
        id: result.artifactId,
        jobId: job.id,
        filename: q.filename,
        contentType,
        sizeBytes: result.size,
        storageProvider: result.provider,
      });
    },
  );

  // ===== List artifacts for a job =====
  app.get<{ Params: { id: string } }>(
    '/api/jobs/:id/artifacts',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const job = await prisma.job.findUnique({ where: { id: req.params.id } });
      if (!job) return reply.code(404).send({ error: { code: 'not_found', message: 'job not found' } });
      const rows = await prisma.artifact.findMany({
        where: { jobId: job.id },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((a) => ({
        id: a.id,
        jobId: a.jobId,
        filename: a.filename,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
        storageProvider: a.storageProvider,
        createdAt: a.createdAt,
      }));
    },
  );

  // ===== Download one artifact (streamed through the API) =====
  app.get<{ Params: { id: string } }>(
    '/api/artifacts/:id',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const art = await prisma.artifact.findUnique({ where: { id: req.params.id } });
      if (!art) return reply.code(404).send({ error: { code: 'not_found', message: 'artifact not found' } });
      reply.header('Content-Type', art.contentType || 'application/octet-stream');
      reply.header('Content-Length', String(art.sizeBytes));
      reply.header('Content-Disposition', `inline; filename="${art.filename.replace(/"/g, '')}"`);
      return reply.send(await openArtifactStream(art.storageKey));
    },
  );

  // ===== Request a presigned (direct) download URL =====
  // For large artifacts the UI prefers to bypass the API and pull straight
  // from S3 / MinIO. Local provider returns an HMAC-signed URL pointing at
  // the /api/artifacts/presigned/:token route below.
  app.get<{ Params: { id: string } }>(
    '/api/artifacts/:id/presigned',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const q = PresignQuery.parse(req.query);
      const art = await prisma.artifact.findUnique({ where: { id: req.params.id } });
      if (!art) return reply.code(404).send({ error: { code: 'not_found', message: 'artifact not found' } });
      const signed = await presignArtifactGet(art.storageKey, q.ttl);
      return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
    },
  );

  // ===== Local-provider presigned-token resolver =====
  // The S3 provider produces URLs that point directly at the bucket so this
  // route is only used in local-dev / Fly-without-S3 setups. Token format is
  // defined in @hive/storage/local-provider.
  app.get<{ Params: { token: string } }>(
    '/api/artifacts/presigned/:token',
    async (req, reply) => {
      try {
        const secret = Buffer.from(env.HIVE_SECRETS_KEY, 'hex');
        const verified = verifyLocalPresign(decodeURIComponent(req.params.token), secret);
        // Try to find a row with this key — gives us filename + content type.
        const art = await prisma.artifact.findFirst({ where: { storageKey: verified.key } });
        if (!art) {
          return reply.code(404).send({ error: { code: 'not_found', message: 'artifact not found' } });
        }
        if (art.storageProvider !== 'local') {
          return reply.code(400).send({
            error: { code: 'wrong_provider', message: `artifact is on '${art.storageProvider}', not local — presigned token should point there directly` },
          });
        }
        reply.header('Content-Type', art.contentType || 'application/octet-stream');
        reply.header('Content-Length', String(art.sizeBytes));
        reply.header('Content-Disposition', `inline; filename="${art.filename.replace(/"/g, '')}"`);
        const storage = getStorageProvider();
        return reply.send(await storage.getStream(verified.key));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(403).send({ error: { code: 'invalid_token', message: msg } });
      }
    },
  );
}
