/**
 * Local-filesystem artifact storage.
 *
 * Layout:  ${HIVE_ARTIFACT_DIR}/${jobId}/${filename}
 *
 * Phase 4b is filesystem-only; the abstraction is intentionally narrow so we
 * can swap in S3 in Phase 5 without touching the routes/UI.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { prisma } from '@hive/db';
import { env } from '../env.js';

export interface SaveResult {
  artifactId: string;
  path: string;
  size: number;
}

/** Reject filenames that try to break out of the per-job directory.
 * basename() strips '/'; we also forbid '..' to be defensive. */
function safeFilename(input: string): string {
  const base = basename(input).trim();
  if (!base || base === '.' || base === '..' || base.includes('/') || base.includes('\\')) {
    throw new Error(`unsafe filename: '${input}'`);
  }
  return base;
}

export function jobDirFor(jobId: string): string {
  return join(env.HIVE_ARTIFACT_DIR, jobId);
}

export async function saveArtifact(
  jobId: string,
  filename: string,
  buffer: Buffer,
  contentType: string,
): Promise<SaveResult> {
  const safe = safeFilename(filename);
  const dir = jobDirFor(jobId);
  await mkdir(dir, { recursive: true });
  const full = join(dir, safe);
  await writeFile(full, buffer);
  const s = await stat(full);
  const row = await prisma.artifact.create({
    data: {
      jobId,
      filename: safe,
      contentType: contentType || 'application/octet-stream',
      sizeBytes: Number(s.size),
      path: resolve(full),
    },
  });
  return { artifactId: row.id, path: row.path, size: row.sizeBytes };
}

export function openReadStream(absolutePath: string): NodeJS.ReadableStream {
  return createReadStream(absolutePath);
}
