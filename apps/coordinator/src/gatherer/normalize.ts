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
  /**
   * The entity this item is about, read from the payload.
   *
   * Subjects were originally per-bot: point one gatherer at one thing. That
   * only works for templates whose config names a single entity, and the most
   * useful sources do the opposite — one poll returns a whole league board, a
   * whole status page, a whole feed. Splitting those across bots would mean N
   * bots each fetching the same document and discarding all but their slice,
   * which is the worst possible trade: N times the requests for the same
   * evidence.
   *
   * So the normalizer names the entity instead. One poll, many findings, each
   * tagged with what it is about, and per-subject analysis works exactly as it
   * does for a fanned-out mission — at a fraction of the requests.
   */
  subject?: string;
}

/**
 * The name two sources would both use for one game.
 *
 * Built from the teams rather than taken from an id, because ids are per-source
 * — DraftKings and FanDuel hash the same fixture differently, and matching on
 * that would put every book in its own subject and corroborate nothing. The
 * matchup is the only identifier they share.
 *
 * Normalised to lower case with collapsed whitespace so "Miami Heat @ Boston
 * Celtics" and "miami heat  @  boston celtics" are one subject; returns
 * undefined when the shape is unrecognised, which leaves the finding
 * subject-less rather than inventing a grouping.
 */
function matchupOf(o: unknown): string | undefined {
  const g = o as Record<string, unknown> | null;
  const away = typeof g?.away === 'string' ? g.away : null;
  const home = typeof g?.home === 'string' ? g.home : null;
  const raw = away && home ? `${away} @ ${home}` : typeof g?.name === 'string' ? g.name : null;
  if (!raw) return undefined;
  const key = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  return key || undefined;
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
          // The matchup, which is what a different source calls the same game.
          subject: matchupOf(g),
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
          subject: matchupOf(e),
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
