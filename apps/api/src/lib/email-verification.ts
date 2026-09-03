import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '@hive/db';

/**
 * Proving someone can read the address they signed up with.
 *
 * Longer-lived than a password reset — a day rather than an hour — because the
 * consequence of an expired link is different. A stale reset link means asking
 * for another one; a stale verification link means a new account that cannot
 * finish signing up, and the person is gone.
 */
export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export function generateVerificationToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashVerificationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Issue a fresh token, invalidating any earlier unused one for this user. */
export async function issueVerificationToken(
  userId: string,
  email: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateVerificationToken();
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
  await prisma.emailVerificationToken.deleteMany({ where: { userId, usedAt: null } });
  await prisma.emailVerificationToken.create({
    data: { userId, email, tokenHash: hashVerificationToken(token), expiresAt },
  });
  return { token, expiresAt };
}

/**
 * Redeem a token, marking the address verified.
 *
 * The token carries the address it was issued for and that address must still
 * be the account's. Otherwise changing your email after requesting a link
 * would let the old link verify the new address — proving you can read an
 * address you no longer use.
 *
 * Both writes go in one transaction: a token consumed without the verification
 * landing would leave someone permanently unable to verify.
 */
export async function redeemVerificationToken(
  token: string,
): Promise<{ ok: true; email: string } | { ok: false; reason: 'invalid' | 'expired' | 'stale' }> {
  const row = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashVerificationToken(token) },
    include: { user: { select: { id: true, email: true, emailVerifiedAt: true } } },
  });
  if (!row || row.usedAt) return { ok: false, reason: 'invalid' };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (row.user.email !== row.email) return { ok: false, reason: 'stale' };

  const now = new Date();
  await prisma.$transaction([
    prisma.emailVerificationToken.update({ where: { id: row.id }, data: { usedAt: now } }),
    prisma.user.update({
      where: { id: row.userId },
      // Only if not already verified, so re-clicking an old link cannot move
      // the date someone's address was confirmed.
      data: { emailVerifiedAt: row.user.emailVerifiedAt ?? now },
    }),
  ]);
  return { ok: true, email: row.email };
}

export function buildVerificationLink(appUrl: string, token: string): string {
  const base = appUrl.replace(/\/$/, '');
  return `${base}/verify-email?token=${encodeURIComponent(token)}`;
}
