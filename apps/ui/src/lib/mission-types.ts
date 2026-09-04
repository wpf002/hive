// Mirrors MissionSnapshot in apps/api/src/routes/mission-stream.ts.
// Kept as a local declaration rather than importing @hive/swarm so the browser
// bundle never pulls in ioredis via that package's entrypoint.

export const SWARM_ROLES = [
  'gatherer',
  'extractor',
  'analyst',
  'adversary',
  'constraint',
  'coordinator',
  'executor',
] as const;
export type SwarmRole = (typeof SWARM_ROLES)[number];

/**
 * One upstream source with its whole fleet of gatherers folded in.
 *
 * Aggregated server-side: a fanned-out mission runs one bot per
 * (source, subject), so this snapshot would otherwise carry hundreds of rows a
 * second to every open terminal for a list that was always grouped by source
 * before anything drew it.
 */
export interface SourceView {
  sourceId: string;
  pool: string;
  /** Gatherer bots on this source — one per subject it covers. */
  bots: number;
  subjects: number;
  running: number;
  /** Polls completed in the activity window, whether or not they produced
   *  anything new. A feed confirming nothing changed is still alive. */
  polls: number;
  /** running | idle | stalled | disabled — worst across the fleet. */
  state: string;
  contributions: number;
  /** Findings from this source in the last few minutes. */
  recentContributions: number;
}

export interface ClaimView {
  id: string;
  claim: string;
  independentSources: number;
  /** The entity the sources agreed about. Empty on a mission with no fan-out. */
  subject: string;
  agentCount: number;
  confidence: number;
  refuted: boolean;
  objections: number;
}

export interface ConstraintResultView {
  rule: string;
  passed: boolean;
  detail?: string;
}

export interface ProposalView {
  id: string;
  action: string;
  status: string;
  rationale: string;
  expiresAt: string;
  constraintResults: ConstraintResultView[];
}

export interface MissionSnapshot {
  missionId: string;
  name: string;
  status: string;
  objective: string;
  sources: SourceView[];
  /** The swarm at a glance: how many bots, how many are working, how wide. */
  fleet: { bots: number; running: number; subjects: number };
  findings: number;
  distinctFindings: number;
  claims: ClaimView[];
  proposals: ProposalView[];
  cost: { todayCents: number; runRateCentsPerHour: number };
  lastDecisionAt: string | null;
  /** Pools with no live worker, and jobs stuck queued because of it. */
  stalled: { pools: string[]; queuedJobs: number };
  /** Findings per minute over the recent window — new evidence arriving. */
  findingsPerMin: number;
  /** Completed polls per minute — work happening, evidence or not. */
  jobsPerMin: number;
}

export interface MissionListItem {
  id: string;
  name: string;
  domain: string;
  objective: string;
  status: string;
  allowedActions: string[];
  approvalMode: string;
  lastDecisionAt: string | null;
  createdAt: string;
  _count: { agents: number; findings: number; hypotheses: number };
}
