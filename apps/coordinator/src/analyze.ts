import Anthropic from '@anthropic-ai/sdk';
import type { Finding, Hypothesis } from '@hive/swarm';
import { env } from './env.js';
import { recordUsage } from './pricing.js';
import { anthropic, modelSemaphore } from './model.js';

/**
 * Analyst: Findings in, Hypotheses out.
 *
 * The analyst is shown findings with their sourceId attached and is told to
 * cite the finding ids that support each claim, because the dedup pass scores
 * independence by counting distinct sources behind those ids. A hypothesis that
 * cites nothing is unscoreable and is dropped rather than defaulted — the same
 * rule the coordinator applies to an unresolvable claim.
 */

const PROPOSE_TOOL: Anthropic.Tool = {
  name: 'record_hypotheses',
  description: 'Record every claim the evidence supports. Return an empty list if none.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['hypotheses'],
    properties: {
      hypotheses: {
        type: 'array',
        description: 'At most 5. Fewer, better-supported claims beat many weak ones.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['claim', 'confidence', 'supportingFindingIds'],
          properties: {
            claim: {
              type: 'string',
              description:
                'One sentence, specific and falsifiable. State what is happening, not that something might be interesting.',
            },
            confidence: { type: 'number', description: '0 to 1.' },
            supportingFindingIds: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Ids of the findings that support this claim, copied exactly. A claim citing none is discarded.',
            },
          },
        },
      },
    },
  },
};

const SYSTEM = `You are an analyst on an agent swarm. You are given recent findings, each with an id and the upstream source it came from. Produce claims the evidence actually supports.

Rules:
1. Cite the exact finding ids behind each claim. Independence is scored downstream by counting how many DISTINCT sources those ids came from, so a claim you cannot cite is worthless.
2. A claim supported by two different sources is worth far more than one supported by two findings from the same source. Prefer claims you can corroborate across sources.
3. Do not restate a finding as a claim. "ESPN reports LAL 102-98" is a finding; "LAL is closing out a game they trailed" is a claim.
4. Returning an empty list is correct and common. Do not manufacture claims to seem useful.
5. Be specific enough that an adversary could try to refute you.`;

export async function analyze(input: {
  missionId: string;
  objective: string;
  findings: Finding[];
}): Promise<Omit<Hypothesis, 'id' | 'agentId'>[]> {
  if (input.findings.length === 0) return [];

  const board = input.findings.map((f) => ({
    id: f.id,
    source: f.provenance.sourceId,
    kind: f.kind,
    observedAt: f.provenance.observedAt,
    payload: f.payload,
  }));

  const res = await modelSemaphore().run(() =>
    anthropic().messages.create({
      model: env.HIVE_ANALYST_MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      tools: [PROPOSE_TOOL],
      tool_choice: { type: 'tool', name: 'record_hypotheses' },
      messages: [
        {
          role: 'user',
          content: JSON.stringify({ objective: input.objective, findings: board }, null, 2),
        },
      ],
    }),
  );

  await recordUsage({
    missionId: input.missionId,
    model: env.HIVE_ANALYST_MODEL,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  });

  const block = res.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'record_hypotheses',
  );
  if (!block) return [];

  const raw = (block.input as { hypotheses?: unknown }).hypotheses;
  if (!Array.isArray(raw)) return [];

  const known = new Set(input.findings.map((f) => f.id));
  const out: Omit<Hypothesis, 'id' | 'agentId'>[] = [];
  for (const h of raw.slice(0, 5)) {
    const o = h as Record<string, unknown>;
    const claim = typeof o.claim === 'string' ? o.claim.trim() : '';
    // Only ids we actually showed it. A hallucinated id would silently inflate
    // the independence count, which is the one number that must not be gameable.
    const ids = Array.isArray(o.supportingFindingIds)
      ? (o.supportingFindingIds as unknown[]).filter(
          (x): x is string => typeof x === 'string' && known.has(x),
        )
      : [];
    if (!claim || ids.length === 0) continue;
    const conf = typeof o.confidence === 'number' ? Math.max(0, Math.min(1, o.confidence)) : 0.5;
    out.push({
      missionId: input.missionId,
      claim,
      confidence: conf,
      supportingFindingIds: ids,
      independentSources: 0, // scored by the dedup pass, never by the model
    });
  }
  return out;
}
