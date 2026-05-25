import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@hive/db';
import { requireAuth } from '../auth.js';
import { openReadStream, saveArtifact } from '../lib/artifacts.js';

const UploadQuery = z.object({
  filename: z.string().min(1),
  contentType: z.string().optional(),
});

export async function artifactRoutes(app: FastifyInstance) {
  // ===== Upload (worker scope only) =====
  // Workers POST raw bytes; query params carry filename + contentType.
  // Cap at 64 MiB to keep blast radius small; Phase 5 will swap to S3 multipart.
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
        createdAt: a.createdAt,
      }));
    },
  );

  // ===== Download one artifact =====
  app.get<{ Params: { id: string } }>(
    '/api/artifacts/:id',
    { preHandler: requireAuth('api') },
    async (req, reply) => {
      const art = await prisma.artifact.findUnique({ where: { id: req.params.id } });
      if (!art) return reply.code(404).send({ error: { code: 'not_found', message: 'artifact not found' } });
      reply.header('Content-Type', art.contentType || 'application/octet-stream');
      reply.header('Content-Length', String(art.sizeBytes));
      reply.header('Content-Disposition', `inline; filename="${art.filename.replace(/"/g, '')}"`);
      return reply.send(openReadStream(art.path));
    },
  );
}
