import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '@hive/db';

// Password reset tokens live for 1 hour. Short enough to limit exposure, long
// enough that an email can arrive and be acted on.
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export function generateResetToken(): string {
  // 32 raw bytes → 256 bits, base64url for URL-safe links.
  return randomBytes(32).toString('base64url');
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Issues a fresh reset token for a user. Invalidates any prior unused tokens
 *  so only the most recent link works. Returns the RAW token (emailed once). */
export async function issueResetToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = generateResetToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  // Burn outstanding tokens for this user — one live reset link at a time.
  await prisma.resetToken.deleteMany({ where: { userId, usedAt: null } });
  await prisma.resetToken.create({
    data: { userId, tokenHash: hashResetToken(token), expiresAt },
  });
  return { token, expiresAt };
}

/** Returns the userId for a valid (unexpired, unused) token, or null. Does NOT
 *  consume the token — call `consumeResetToken` after the password is updated. */
export async function findValidResetToken(token: string): Promise<{ id: string; userId: string } | null> {
  const row = await prisma.resetToken.findUnique({ where: { tokenHash: hashResetToken(token) } });
  if (!row) return null;
  if (row.usedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return { id: row.id, userId: row.userId };
}

export async function consumeResetToken(id: string): Promise<void> {
  await prisma.resetToken.update({ where: { id }, data: { usedAt: new Date() } });
}

export function buildResetLink(appUrl: string, token: string): string {
  const base = appUrl.replace(/\/$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}
