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

export interface AgentView {
  id: string;
  botId: string;
  botName: string;
  role: string;
  pool: string;
  sourceId: string | null;
  /** running | idle | stalled | disabled */
  state: string;
  contributions: number;
}

export interface ClaimView {
  id: string;
  claim: string;
  independentSources: number;
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
  agents: AgentView[];
  findings: number;
  distinctFindings: number;
  claims: ClaimView[];
  proposals: ProposalView[];
  cost: { todayCents: number; runRateCentsPerHour: number };
  lastDecisionAt: string | null;
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
