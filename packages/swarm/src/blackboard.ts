import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  BoardEvent,
  type BoardEventType,
  type Challenge,
  type Finding,
  type Hypothesis,
  type Proposal,
} from './types.js';

/**
 * Shared mission state. Agents subscribe to the event kinds they care about
 * rather than being wired into a fixed graph — adding a role means adding a
 * subscriber, not rewiring the mission.
 *
 * Stream: hive:mission:<missionId>:board
 * Consumer groups: one per role (`role:<name>`), so every role sees every
 * entry and filters client-side. One stream, no fan-out duplication in Redis.
 */

/** Approximate cap on board length. Keeps snapshot() bounded on long missions. */
const DEFAULT_MAXLEN = 10_000;

export interface BoardSnapshot {
  findings: Finding[];
  hypotheses: Hypothesis[];
  challenges: Challenge[];
  proposals: Proposal[];
  /** Last stream id included, for incremental tailing. */
  lastId: string | null;
}

export function boardStream(missionId: string): string {
  return `hive:mission:${missionId}:board`;
}

export class Blackboard {
  private readonly consumerSuffix: string;

  constructor(
    private readonly redis: Redis,
    private readonly missionId: string,
    private readonly opts: { maxlen?: number } = {},
  ) {
    this.consumerSuffix = process.env.HOSTNAME ?? randomUUID().slice(0, 8);
  }

  get stream(): string {
    return boardStream(this.missionId);
  }

  async post(event: BoardEvent): Promise<string> {
    BoardEvent.parse(event);
    return (await this.redis.xadd(
      this.stream,
      'MAXLEN',
      '~',
      String(this.opts.maxlen ?? DEFAULT_MAXLEN),
      '*',
      'type',
      event.type,
      'payload',
      JSON.stringify(event.data),
    )) as string;
  }

  async ensureGroup(role: string): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.stream, `role:${role}`, '0', 'MKSTREAM');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('BUSYGROUP')) throw err;
    }
  }

  /**
   * Pull the next batch for a role. Entries whose kind the role doesn't
   * subscribe to are acked immediately so the group's pending list stays small.
   */
  async read(
    role: string,
    kinds: BoardEventType[],
    opts: { count?: number; blockMs?: number } = {},
  ): Promise<{ ackId: string; event: BoardEvent }[]> {
    await this.ensureGroup(role);
    const consumer = `${role}:${this.consumerSuffix}`;
    const res = (await this.redis.xreadgroup(
      'GROUP',
      `role:${role}`,
      consumer,
      'COUNT',
      String(opts.count ?? 32),
      'BLOCK',
      String(opts.blockMs ?? 5_000),
      'STREAMS',
      this.stream,
      '>',
    )) as [string, [string, string[]][]][] | null;
    if (!res) return [];

    const out: { ackId: string; event: BoardEvent }[] = [];
    for (const [, entries] of res) {
      for (const [id, fields] of entries) {
        const event = parseEntry(fields);
        if (event && kinds.includes(event.type)) out.push({ ackId: id, event });
        else await this.redis.xack(this.stream, `role:${role}`, id);
      }
    }
    return out;
  }

  async ack(role: string, ackId: string): Promise<void> {
    await this.redis.xack(this.stream, `role:${role}`, ackId);
  }

  async ackAll(role: string, ackIds: string[]): Promise<void> {
    if (ackIds.length === 0) return;
    await this.redis.xack(this.stream, `role:${role}`, ...ackIds);
  }

  /**
   * Board snapshot for the coordinator and the terminal UI.
   *
   * `from` makes this incremental: pass the previous snapshot's `lastId` to
   * read only what landed since. The full read is bounded by the MAXLEN trim
   * on post(), so a long-running mission can't turn this into an unbounded scan.
   */
  async snapshot(from = '-'): Promise<BoardSnapshot> {
    const start = from === '-' ? '-' : `(${from}`;
    const entries = (await this.redis.xrange(this.stream, start, '+')) as [string, string[]][];
    const snap: BoardSnapshot = {
      findings: [],
      hypotheses: [],
      challenges: [],
      proposals: [],
      lastId: null,
    };
    for (const [id, fields] of entries) {
      snap.lastId = id;
      const event = parseEntry(fields);
      if (!event) continue;
      if (event.type === 'finding') snap.findings.push(event.data);
      else if (event.type === 'hypothesis') snap.hypotheses.push(event.data);
      else if (event.type === 'challenge') snap.challenges.push(event.data);
      else snap.proposals.push(event.data);
    }
    return snap;
  }

  /** Current board length — cheap, for status lines that don't need contents. */
  async length(): Promise<number> {
    return this.redis.xlen(this.stream);
  }
}

function parseEntry(fields: string[]): BoardEvent | null {
  const map: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) map[fields[i]] = fields[i + 1];
  if (!map.type || !map.payload) return null;
  try {
    return { type: map.type, data: JSON.parse(map.payload) } as BoardEvent;
  } catch {
    return null;
  }
}
