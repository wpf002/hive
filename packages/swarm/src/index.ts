// Explicit named re-exports (NOT `export *`), matching @hive/shared: esbuild
// compiles `export *` into a runtime property copy that Node's native ESM
// linker can't see at link time, so downstream `import { X }` fails under
// tsx watch. Naming each binding keeps runtime + typecheck in agreement.
export {
  SWARM_ROLES,
  SwarmRole,
  ROLE_SUBSCRIPTIONS,
  Provenance,
  Finding,
  Hypothesis,
  ChallengeSeverity,
  Challenge,
  PROPOSAL_STATUSES,
  ProposalStatus,
  ConstraintResult,
  Proposal,
  BOARD_EVENT_TYPES,
  BoardEvent,
} from './types.js';
export type { BoardEventType, Decision } from './types.js';

export { Blackboard, boardStream } from './blackboard.js';
export type { BoardSnapshot } from './blackboard.js';

export { BoardView } from './board-view.js';

export {
  collapseFindings,
  scoreIndependence,
  clusterByClaim,
  selectCluster,
  normalizeClaim,
} from './dedup.js';
export type { ClaimCluster } from './dedup.js';

export { evaluate, coreRules } from './constraints.js';
export type { ConstraintRule, ConstraintContext } from './constraints.js';
