import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison. Guards static-token checks against timing
 * side-channels. Returns false on any length mismatch (the length comparison
 * itself is not secret — token lengths are fixed by configuration).
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
