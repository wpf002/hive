import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '@hive/db';

export const SESSION_COOKIE = 'hive_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateSessionToken(): string {
  // 32 raw bytes → 256 bits of entropy, base64url-encoded for cookie safety.
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(args: {
  userId: string;
  token: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<{ expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({
    data: {
      userId: args.userId,
      tokenHash: hashSessionToken(args.token),
      expiresAt,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
    },
  });
  return { expiresAt };
}

export async function findValidSession(token: string) {
  const tokenHash = hashSessionToken(token);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    // Lazy expiry sweep — delete the row so it can't be reused.
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  return session;
}

export async function revokeSession(token: string): Promise<void> {
  const tokenHash = hashSessionToken(token);
  await prisma.session.deleteMany({ where: { tokenHash } });
}

export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

export function cookieOptionsForSession(): {
  path: string;
  httpOnly: boolean;
  sameSite: 'lax';
  secure: boolean;
  maxAge: number;
} {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // In production set SECURE_COOKIES=true; dev is plain HTTP so cookies must
    // be non-secure or the browser won't accept them.
    secure: process.env.SECURE_COOKIES === 'true',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}
