import type { Blackboard, BoardSnapshot } from './blackboard.js';
import type { Challenge, Finding, Hypothesis, Proposal } from './types.js';

/**
 * An accumulating, bounded view of a mission board.
 *
 * Both readers of the board — the coordinator loop and the terminal's SSE
 * stream — need the *whole* board to reason over (dedup and claim clustering
 * are global operations, not per-entry ones) but must not re-read the whole
 * stream every tick. `refresh()` reads only what landed since the last call and
 * appends it.
 *
 * The window is bounded. Without a cap, a mission running for days would grow
 * this view without limit even though the stream itself is trimmed on write —
 * the reader would outlive the data it mirrors. Oldest entries are dropped
 * first, which matches the stream's own MAXLEN behaviour: a claim whose
 * supporting findings have aged out of the window loses that support rather
 * than keeping it forever on the strength of evidence nobody can still see.
 */

const DEFAULT_CAP = 5_000;

export class BoardView {
  private readonly findings: Finding[] = [];
  private readonly hypotheses: Hypothesis[] = [];
  private readonly challenges: Challenge[] = [];
  private readonly proposals: Proposal[] = [];
  private lastId: string | null = null;

  constructor(
    private readonly board: Blackboard,
    private readonly cap: number = DEFAULT_CAP,
  ) {}

  /** Reads everything since the previous refresh. Returns how many entries arrived. */
  async refresh(): Promise<number> {
    const delta = await this.board.snapshot(this.lastId ?? '-');
    const n =
      delta.findings.length +
      delta.hypotheses.length +
      delta.challenges.length +
      delta.proposals.length;

    this.findings.push(...delta.findings);
    this.hypotheses.push(...delta.hypotheses);
    this.challenges.push(...delta.challenges);
    this.proposals.push(...delta.proposals);
    if (delta.lastId) this.lastId = delta.lastId;

    trim(this.findings, this.cap);
    trim(this.hypotheses, this.cap);
    trim(this.challenges, this.cap);
    trim(this.proposals, this.cap);

    return n;
  }

  /** The accumulated board. Arrays are the live buffers — treat as read-only. */
  get state(): BoardSnapshot {
    return {
      findings: this.findings,
      hypotheses: this.hypotheses,
      challenges: this.challenges,
      proposals: this.proposals,
      lastId: this.lastId,
    };
  }

  get size(): number {
    return (
      this.findings.length +
      this.hypotheses.length +
      this.challenges.length +
      this.proposals.length
    );
  }
}

function trim<T>(arr: T[], cap: number): void {
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}
