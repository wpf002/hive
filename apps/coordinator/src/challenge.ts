import Anthropic from '@anthropic-ai/sdk';
import type { Challenge, Finding, Hypothesis } from '@hive/swarm';
import { env } from './env.js';
import { recordUsage } from './pricing.js';
import { anthropic, modelSemaphore } from './model.js';

/**
 * Adversary: attacks a hypothesis and reports what it found.
 *
 * Its prompt is deliberately asymmetric — it is asked to refute, not to
 * evaluate. An agent asked whether a claim is "good" agrees with it most of the
 * time; an agent asked to break it produces the objection that matters. The
 * severity it returns is consequential: `refutes` disqualifies the claim
 * outright through the `not_refuted` constraint rule, so the prompt spends most
 * of its words on when that verdict is and is not warranted.
 */

const CHALLENGE_TOOL: Anthropic.Tool = {
  name: 'record_objections',
  description: 'Record objections to the claim. An empty list means it survived.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['objections'],
    properties: {
      objections: {
        type: 'array',
        description: 'At most 3, strongest first.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['objection', 'severity'],
          properties: {
            objection: { type: 'string', description: 'One or two sentences. Concrete.' },
            severity: {
              type: 'string',
              enum: ['note', 'weakens', 'refutes'],
              description:
                'refutes = the claim is false or its evidence does not support it. weakens = real doubt, claim may still stand. note = worth recording only.',
            },
          },
        },
      },
    },
  },
};

const SYSTEM = `You are an adversary on an agent swarm. You are given ONE claim and the evidence cited for it. Your job is to break it.

Attack these, in order:
1. Does the cited evidence actually support the claim, or merely sit near it?
2. Is the support one source wearing several hats? Findings from the same sourceId are one signal however many there are.
3. Is the evidence stale relative to what the claim asserts?
4. Is there a simpler reading of the same evidence?

On severity — this is consequential, so be exact:
- "refutes" disqualifies the claim outright and removes it from consideration. Use it only when the claim is false, or when the cited evidence genuinely cannot support it. Do not use it for a claim you merely find weak.
- "weakens" is the right verdict for real but non-fatal doubt. Reach for it first.
- "note" records a caveat.

Returning no objections is a valid and useful answer: it means the claim survived a genuine attempt to break it. Do not invent an objection to look diligent.`;

export async function challenge(input: {
  missionId: string;
  objective: string;
  hypothesis: Hypothesis;
  evidence: Finding[];
}): Promise<Omit<Challenge, 'id' | 'agentId'>[]> {
  const cited = input.evidence.filter((f) => input.hypothesis.supportingFindingIds.includes(f.id));

  const res = await modelSemaphore().run(() =>
    anthropic().messages.create({
      model: env.HIVE_ADVERSARY_MODEL,
      max_tokens: 1200,
      system: SYSTEM,
      tools: [CHALLENGE_TOOL],
      tool_choice: { type: 'tool', name: 'record_objections' },
      messages: [
        {
          role: 'user',
          content: JSON.stringify(
            {
              objective: input.objective,
              claim: input.hypothesis.claim,
              statedConfidence: input.hypothesis.confidence,
              evidence: cited.map((f) => ({
                id: f.id,
                source: f.provenance.sourceId,
                observedAt: f.provenance.observedAt,
                payload: f.payload,
              })),
              distinctSources: new Set(cited.map((f) => f.provenance.sourceId)).size,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  await recordUsage({
    missionId: input.missionId,
    model: env.HIVE_ADVERSARY_MODEL,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  });

  const block = res.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'record_objections',
  );
  if (!block) return [];
  const raw = (block.input as { objections?: unknown }).objections;
  if (!Array.isArray(raw)) return [];

  const out: Omit<Challenge, 'id' | 'agentId'>[] = [];
  for (const c of raw.slice(0, 3)) {
    const o = c as Record<string, unknown>;
    const objection = typeof o.objection === 'string' ? o.objection.trim() : '';
    const severity = o.severity;
    if (!objection) continue;
    if (severity !== 'note' && severity !== 'weakens' && severity !== 'refutes') continue;
    out.push({ hypothesisId: input.hypothesis.id, objection, severity });
  }
  return out;
}
