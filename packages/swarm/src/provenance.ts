import { createHash } from 'node:crypto';

/**
 * The hashing authority for Finding provenance.
 *
 * `contentHash` is half the dedup key the database enforces —
 * `@@unique([missionId, sourceId, contentHash])` — and it is the only part of
 * that key the ingest path controls. Get it wrong in either direction and the
 * whole thesis fails: hash something volatile and an unchanged feed looks new
 * every poll, hash too coarsely and one changed row invalidates every other row
 * from the same fetch.
 *
 * Hashing lives in TypeScript only, deliberately. Python's `json.dumps` emits
 * `1.0` where `JSON.stringify` emits `1` and inserts separator spaces by
 * default, so a cross-language hash of identical data diverges silently — and a
 * dedup pass that fails open is worse than no dedup at all, because it still
 * looks like it is working.
 */

/**
 * Deterministic JSON: keys sorted, array order preserved, no whitespace,
 * `undefined` properties dropped, `null` kept.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** sha256 of the canonical form. Always 64 lowercase hex characters. */
export function contentHash(v: unknown): string {
  return createHash('sha256').update(canonicalJson(v), 'utf8').digest('hex');
}

/**
 * Fields that must never reach the hash.
 *
 * `jobId` is the dangerous one: it is unique per run, so including it makes
 * every hash unique and silently disables deduplication entirely while every
 * other part of the system continues to look healthy.
 */
export const NEVER_HASH = [
  'jobId',
  'agentId',
  'missionId',
  'sourceId',
  'observedAt',
  'fetchedAt',
] as const;

/** Drops the given keys from a shallow object before hashing. */
export function stripVolatile<T extends Record<string, unknown>>(
  obj: T,
  volatileKeys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const drop = new Set<string>([...NEVER_HASH, ...volatileKeys]);
  for (const [k, v] of Object.entries(obj)) if (!drop.has(k)) out[k] = v;
  return out;
}

/**
 * Normalizes any timestamp-ish value to an ISO string with a `Z` suffix.
 *
 * `Provenance` validates timestamps with zod's `.datetime()`, which accepts
 * `Z` only — and Python's `datetime.now(timezone.utc).isoformat()` emits
 * `+00:00`, which fails that parse and would throw inside `Blackboard.post`.
 * Everything crossing the boundary gets re-serialized through `Date`.
 */
export function isoUtc(value: unknown, fallback: Date): string {
  const t = value == null ? NaN : new Date(value as string | number | Date).getTime();
  return new Date(Number.isFinite(t) ? t : fallback.getTime()).toISOString();
}
