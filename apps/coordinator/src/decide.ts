import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@hive/db';
import type { ClaimCluster, Decision } from '@hive/swarm';
import { env } from './env.js';
import { recordUsage } from './pricing.js';

/**
 * Head of desk. One model call, one decision.
 *
 * The prompt is deliberately explicit that agent agreement is not evidence —
 * only `independentSources` is. Without that framing the model reads a wall of
 * concurring agents as strong signal, which is exactly the failure the dedup
 * pass exists to prevent.
 *
 * Uses tool-use rather than free-text JSON so the shape is enforced by the API
 * instead of by a regex over a fenced code block (same approach as the AI bot
 * builder in apps/api/src/routes/bot-builder.ts).
 */

const DECIDE_TOOL: Anthropic.Tool = {
  name: 'record_decision',
  description:
    'Record the single decision for this board state. Use action: null when no claim clears the bar.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'claim', 'params', 'rationale'],
    properties: {
      action: {
        type: ['string', 'null'],
        description:
          'One of the mission’s allowed actions, or null to do nothing. Doing nothing is a valid decision.',
      },
      claim: {
        type: ['string', 'null'],
        description:
          'The `claim` string of the ONE board entry that motivated this action, copied back verbatim. Null when action is null. This is what the deterministic gates are scored against, so it must be the claim you actually acted on.',
      },
      params: {
        type: 'object',
        description: 'Parameters for the executor verb. Empty object when action is null.',
      },
      rationale: {
        type: 'string',
        description:
          'One or two sentences. Cite independent source counts, not how many agents agreed.',
      },
    },
  },
};

const SYSTEM_PROMPT = `You are the coordinator for an agent swarm. You see the whole board and return exactly one decision.

Rules, in priority order:
1. agentCount is NOT evidence. Many agents reading one source is one signal observed many times. Ignore it when weighing support.
2. independentSources is the only support measure that counts. It is the number of distinct upstream sources behind a claim.
3. A claim with refuted: true is disqualified outright, whatever its support.
4. Objections with severity "weakens" should lower your confidence but do not disqualify.
5. action must be one of the mission's allowed actions, or null.
6. If no claim clears the bar, return action: null. Doing nothing is a valid and common decision — prefer it over a marginal call.
7. When you do act, copy the motivating claim back verbatim into the "claim" field. The deterministic gates are applied to that claim. A claim you did not copy exactly cannot be gated, and the proposal is discarded.

Call record_decision exactly once.`;

// Cents per million tokens. Mirrors workers/ai_agent/src/pricing.ts; the
// coordinator is the only model call in this service so a local table is
// cheaper than exporting one from a worker package.
let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is required to run a mission coordinator');
    }
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

export interface DecideInput {
  missionId: string;
  objective: string;
  allowedActions: string[];
  clusters: ClaimCluster[];
  /** Rules the coordinator should know about so it stops proposing what will be gated. */
  limits: Record<string, number>;
}

export async function decide(input: DecideInput): Promise<Decision> {
  if (input.allowedActions.length === 0) {
    return {
      action: null,
      claim: null,
      params: {},
      rationale: 'mission has no allowed actions configured',
    };
  }

  // Only the fields the model should reason over. `agentCount` is included on
  // purpose — the prompt names it as a trap, and hiding it would make the
  // model's reasoning untestable against the failure mode we care about.
  const board = input.clusters.slice(0, 40).map((c) => ({
    claim: c.claim,
    independentSources: c.independentSources,
    agentCount: c.members.length,
    meanConfidence: Number(c.meanConfidence.toFixed(3)),
    refuted: c.refuted,
    objections: c.objections.map((o) => ({ severity: o.severity, objection: o.objection })),
  }));

  const res = await anthropic().messages.create({
    model: env.HIVE_COORDINATOR_MODEL,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    tools: [DECIDE_TOOL],
    tool_choice: { type: 'tool', name: 'record_decision' },
    messages: [
      {
        role: 'user',
        content: JSON.stringify(
          {
            objective: input.objective,
            allowedActions: input.allowedActions,
            minIndependentSources: input.limits.min_independent_sources ?? 2,
            board,
          },
          null,
          2,
        ),
      },
    ],
  });

  // Cost tracking through the shared recorder rather than a second price table
  // of its own. Two tables meant two chances to be wrong about what a model
  // costs, and one of them was — by a factor of ten, for months, in the number
  // the console showed the operator.
  await recordUsage({
    missionId: input.missionId,
    model: env.HIVE_COORDINATOR_MODEL,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  });

  const block = res.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'record_decision',
  );
  if (!block) {
    return { action: null, claim: null, params: {}, rationale: 'coordinator returned no decision' };
  }

  const raw = block.input as {
    action?: unknown;
    claim?: unknown;
    params?: unknown;
    rationale?: unknown;
  };
  const action = typeof raw.action === 'string' && raw.action.length > 0 ? raw.action : null;
  const claim = typeof raw.claim === 'string' && raw.claim.length > 0 ? raw.claim : null;

  // Belt and braces: the constraint pass rejects a disallowed action too, but
  // there's no reason to write a proposal we already know is invalid.
  if (action && !input.allowedActions.includes(action)) {
    return {
      action: null,
      claim: null,
      params: {},
      rationale: `coordinator proposed disallowed action "${action}"`,
    };
  }

  return {
    action,
    claim,
    params: (raw.params && typeof raw.params === 'object' ? raw.params : {}) as Record<
      string,
      unknown
    >,
    rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
  };
}
