import type { Proposal } from './types.js';

/**
 * Deterministic gates. These are code, never a model call.
 *
 * A model that can be talked into raising a limit is not a risk control, it is
 * a vulnerability with a confidence score. Constraint rules run after the
 * coordinator and before anything reaches the approval queue.
 */

export interface ConstraintContext {
  now: Date;
  /** Mission-scoped counters, derived from executed proposals in the window. */
  counters: Record<string, number>;
  /** Mission config limits (Mission.limits). */
  limits: Record<string, number>;
  /** Executor verbs this mission is allowed to propose (Mission.allowedActions). */
  allowedActions: string[];
}

export interface ConstraintRule {
  name: string;
  /** Pure. No I/O, no model calls, no clock reads outside `ctx`. */
  check: (proposal: Proposal, ctx: ConstraintContext) => { passed: boolean; detail?: string };
}

export const coreRules: ConstraintRule[] = [
  {
    name: 'not_expired',
    check: (p, ctx) => ({
      passed: new Date(p.expiresAt) > ctx.now,
      detail: `expires ${p.expiresAt}`,
    }),
  },
  {
    name: 'action_allowed',
    check: (p, ctx) => ({
      passed: ctx.allowedActions.includes(p.action),
      detail: `${p.action} vs [${ctx.allowedActions.join(', ') || 'none'}]`,
    }),
  },
  {
    name: 'action_rate_limit',
    check: (p, ctx) => {
      const used = ctx.counters[`action:${p.action}`] ?? 0;
      const cap = ctx.limits[`action:${p.action}`] ?? Infinity;
      return { passed: used < cap, detail: `${used}/${fmtCap(cap)} this window` };
    },
  },
  {
    name: 'mission_action_budget',
    check: (_p, ctx) => {
      const used = ctx.counters['mission:actions'] ?? 0;
      const cap = ctx.limits['mission:actions'] ?? Infinity;
      return { passed: used < cap, detail: `${used}/${fmtCap(cap)} actions` };
    },
  },
  {
    name: 'requires_independent_support',
    check: (p, ctx) => {
      const n = Number(p.params.independentSources ?? 0);
      const min = ctx.limits.min_independent_sources ?? 2;
      return { passed: n >= min, detail: `${n} independent sources, need ${min}` };
    },
  },
  {
    name: 'not_refuted',
    check: (p) => {
      const refuted = p.params.refuted === true;
      return { passed: !refuted, detail: refuted ? 'an adversary refuted this claim' : 'no refutation' };
    },
  },
];

export function evaluate(
  proposal: Proposal,
  ctx: ConstraintContext,
  rules: ConstraintRule[] = coreRules,
): Proposal {
  const constraintResults = rules.map((r) => {
    const { passed, detail } = r.check(proposal, ctx);
    return { rule: r.name, passed, detail };
  });
  const failed = constraintResults.some((r) => !r.passed);
  return {
    ...proposal,
    constraintResults,
    status: failed ? 'rejected' : proposal.status,
  };
}

function fmtCap(cap: number): string {
  return Number.isFinite(cap) ? String(cap) : '∞';
}
