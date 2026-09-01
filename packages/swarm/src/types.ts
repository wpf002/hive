import { z } from 'zod';

/**
 * Role taxonomy. Domain-agnostic by design: a mission is a composition of these
 * roles bound to concrete bots, not a hardcoded workflow. Adding a capability
 * means adding an agent in a role, not editing a DAG.
 */
export const SWARM_ROLES = [
  'gatherer', // pulls raw material from exactly one source
  'extractor', // raw -> structured Finding
  'analyst', // Findings -> Hypothesis
  'adversary', // attacks a Hypothesis
  'constraint', // deterministic pass/fail. never a model.
  'coordinator', // collapses the board into one Decision
  'executor', // acts, only on an approved Proposal
] as const;

export const SwarmRole = z.enum(SWARM_ROLES);
export type SwarmRole = z.infer<typeof SwarmRole>;

/** Which board event kinds each role consumes by default. */
export const ROLE_SUBSCRIPTIONS: Record<SwarmRole, BoardEventType[]> = {
  gatherer: [],
  extractor: ['finding'],
  analyst: ['finding'],
  adversary: ['hypothesis'],
  constraint: ['proposal'],
  coordinator: ['hypothesis', 'challenge'],
  executor: ['proposal'],
};

/**
 * Provenance is mandatory. Findings without it cannot be deduplicated, and a
 * board that can't deduplicate reads 300 agents echoing one feed as consensus.
 */
export const Provenance = z.object({
  sourceId: z.string().min(1), // stable id of the upstream source
  /**
   * The entity this observation is about — a ticker, a game, a repo, a URL.
   * Empty means the whole feed.
   *
   * Independence is scored *within* a subject: two sources agreeing about AAPL
   * is corroboration, one source on AAPL plus another on MSFT is not. Without
   * this, fanning a mission out over hundreds of subjects would let unrelated
   * observations count as agreement.
   */
  subject: z.string().default(''),
  sourceKind: z.string().min(1), // 'http' | 'rss' | 'exchange' | 'repo' | ...
  observedAt: z.string().datetime(), // when the source produced it, not when we read it
  fetchedAt: z.string().datetime(),
  contentHash: z.string().length(64), // sha256 of the normalized raw payload
  jobId: z.string(),
});
export type Provenance = z.infer<typeof Provenance>;

export const Finding = z.object({
  id: z.string(),
  missionId: z.string(),
  agentId: z.string(),
  kind: z.string(), // mission-defined: 'price', 'headline', 'commit', ...
  payload: z.record(z.unknown()),
  provenance: Provenance,
});
export type Finding = z.infer<typeof Finding>;

export const Hypothesis = z.object({
  id: z.string(),
  missionId: z.string(),
  agentId: z.string(),
  claim: z.string(),
  confidence: z.number().min(0).max(1),
  supportingFindingIds: z.array(z.string()).min(1),
  /** Set by the dedup pass. How many *independent* sources back this claim. */
  independentSources: z.number().int().nonnegative().default(0),
});
export type Hypothesis = z.infer<typeof Hypothesis>;

export const ChallengeSeverity = z.enum(['note', 'weakens', 'refutes']);
export type ChallengeSeverity = z.infer<typeof ChallengeSeverity>;

export const Challenge = z.object({
  id: z.string(),
  hypothesisId: z.string(),
  agentId: z.string(),
  objection: z.string(),
  severity: ChallengeSeverity,
});
export type Challenge = z.infer<typeof Challenge>;

export const PROPOSAL_STATUSES = [
  'pending',
  'approved',
  // Claimed by an executor. The transition approved -> executing is what makes
  // double-execution impossible: it is a conditional update, so exactly one
  // executor can win it.
  'executing',
  'rejected',
  'expired',
  'executed',
  'failed',
] as const;
export const ProposalStatus = z.enum(PROPOSAL_STATUSES);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const ConstraintResult = z.object({
  rule: z.string(),
  passed: z.boolean(),
  detail: z.string().optional(),
});
export type ConstraintResult = z.infer<typeof ConstraintResult>;

export const Proposal = z.object({
  id: z.string(),
  missionId: z.string(),
  action: z.string(), // mission-defined executor verb
  params: z.record(z.unknown()),
  rationale: z.string(),
  status: ProposalStatus,
  expiresAt: z.string().datetime(), // hard TTL. stale approvals must not fire.
  constraintResults: z.array(ConstraintResult),
});
export type Proposal = z.infer<typeof Proposal>;

export const BOARD_EVENT_TYPES = ['finding', 'hypothesis', 'challenge', 'proposal'] as const;
export type BoardEventType = (typeof BOARD_EVENT_TYPES)[number];

export const BoardEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('finding'), data: Finding }),
  z.object({ type: z.literal('hypothesis'), data: Hypothesis }),
  z.object({ type: z.literal('challenge'), data: Challenge }),
  z.object({ type: z.literal('proposal'), data: Proposal }),
]);
export type BoardEvent = z.infer<typeof BoardEvent>;

/** What the coordinator's single model call returns. */
export interface Decision {
  action: string | null;
  /**
   * The board claim this decision was about, copied verbatim from the input.
   * Required so the constraint gates can score the claim actually chosen
   * rather than whichever claim happens to rank first. Null when action is null.
   */
  claim: string | null;
  params: Record<string, unknown>;
  rationale: string;
}
