import { isoUtc, stripVolatile } from '@hive/swarm';

/**
 * Turns a completed job's result into the individual upstream observations it
 * contains, and declares which fields must not reach the content hash.
 *
 * Granularity is per-item, never per-job. Hashing a whole scoreboard means one
 * game's score changing invalidates every other game in the same fetch, so the
 * dedup pass collapses almost nothing and the board fills with near-duplicates
 * that all look like fresh evidence.
 *
 * The volatile-field lists below are the load-bearing part. Two of the three
 * gatherer payloads embed a value that changes on every single poll, and
 * hashing either one defeats deduplication completely while leaving every other
 * part of the system looking healthy.
 */

export interface NormalizedItem {
  /** Becomes Finding.kind. */
  kind: string;
  /** Exactly what the content hash sees. */
  hashed: Record<string, unknown>;
  /** Becomes Finding.payload — served over HTTP, so it may hold more. */
  payload: Record<string, unknown>;
  /** When the source produced it, if the payload says. */
  observedAt?: string;
}

export interface Normalized {
  items: NormalizedItem[];
  fetchedAt: string;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!asObj(x)) : [];
}

/**
 * Returns null when the template produces nothing worth treating as evidence.
 * A heartbeat, for example, is a liveness ping whose only varying fields are a
 * timestamp and a hostname — hashing it would manufacture a new "finding" every
 * run and drown the board.
 */
export function normalizeResult(
  templateName: string,
  result: unknown,
  finishedAt: Date,
): Normalized | null {
  const root = asObj(result);
  if (!root) return null;

  switch (templateName) {
    case 'ESPN Scoreboard Scraper': {
      // The envelope carries `date`, derived from datetime.now() at scrape
      // time, so an unchanged game would re-hash at every UTC midnight.
      // Each game object is hashed whole: a score move is exactly the change
      // deduplication should register.
      const games = asArr(root.games);
      if (games.length === 0) return null;
      return {
        fetchedAt: isoUtc(root.fetchedAt, finishedAt),
        items: games.map((g) => ({
          kind: 'game',
          hashed: stripVolatile(g, []),
          payload: g,
          observedAt: undefined,
        })),
      };
    }

    case 'Sportsbook Line Scraper': {
      // `fetchedAt` is regenerated every poll — the single field that would
      // break sportsbook dedup outright if it reached the hash.
      const events = asArr(root.events);
      if (events.length === 0) return null;
      return {
        fetchedAt: isoUtc(root.fetchedAt, finishedAt),
        items: events.map((e) => ({
          kind: 'line',
          hashed: stripVolatile(e, []),
          payload: e,
          observedAt: undefined,
        })),
      };
    }

    case 'HTTP Endpoint Monitor':
    case 'HTTP Health Check': {
      // `latencyMs` is a measured duration and differs on essentially every
      // poll; what matters is whether the endpoint is up and what it returned.
      return {
        fetchedAt: isoUtc(root.fetchedAt, finishedAt),
        items: [
          {
            kind: 'endpoint',
            hashed: stripVolatile(root, ['latencyMs', 'ranAt', 'durationMs']),
            payload: root,
          },
        ],
      };
    }

    case 'Cron Heartbeat':
      // Liveness only — every varying field is a clock or a hostname.
      return null;

    default: {
      // Unknown template: hash the whole result minus the fields that are
      // volatile across every pool we have seen. Conservative rather than
      // clever — a wrong guess here shows up as board noise, not silence.
      return {
        fetchedAt: isoUtc(root.fetchedAt, finishedAt),
        items: [
          {
            kind: 'result',
            hashed: stripVolatile(root, ['latencyMs', 'durationMs', 'ranAt', 'timestamp']),
            payload: root,
          },
        ],
      };
    }
  }
}
