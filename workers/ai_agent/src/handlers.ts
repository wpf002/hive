import { z } from 'zod';
import type { Handler } from '@hive/worker-base-ts';
import { type Provider, DEFAULT_MODELS } from './pricing.js';
import { type CallResult, callProvider, ProviderError } from './providers.js';

const ProviderEnum = z.enum(['claude', 'gpt', 'perplexity']);

const SingleConfig = z.object({
  provider: ProviderEnum,
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  userPrompt: z.string().min(1),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  jsonMode: z.boolean().optional(),
  stream: z.boolean().optional(),
});

export const singleCallHandler: Handler = async (rawConfig, { log, jobId }) => {
  const config = SingleConfig.parse(rawConfig);
  const result = await callProvider(
    {
      provider: config.provider,
      model: config.model,
      systemPrompt: config.systemPrompt,
      userPrompt: config.userPrompt,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      jsonMode: config.jsonMode,
      stream: config.stream,
    },
    log,
    jobId,
  );
  if (config.stream) {
    await log.info('ai.response.complete', {
      provider: result.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costCents: result.costCents,
      latencyMs: result.latencyMs,
    });
  }

  let parsed: unknown = undefined;
  if (config.jsonMode) {
    try { parsed = JSON.parse(result.response); } catch { /* keep raw response only */ }
  }

  return {
    provider: result.provider,
    model: result.model,
    response: result.response,
    parsed,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: result.latencyMs,
    costCents: result.costCents,
  };
};

const MultiConfig = z.object({
  providers: z.array(ProviderEnum).min(2).default(['claude', 'gpt', 'perplexity']),
  systemPrompt: z.string().optional(),
  userPrompt: z.string().min(1),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  verdictMode: z.enum(['consensus', 'best', 'all']).default('consensus'),
});

interface ProviderSlot {
  provider: Provider;
  model: string;
  response?: string;
  latencyMs?: number;
  costCents?: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

export const multiProviderHandler: Handler = async (rawConfig, { log, jobId }) => {
  const config = MultiConfig.parse(rawConfig);

  const settled = await Promise.allSettled(
    config.providers.map((p) =>
      callProvider(
        {
          provider: p,
          systemPrompt: config.systemPrompt,
          userPrompt: config.userPrompt,
          maxTokens: config.maxTokens,
          temperature: config.temperature,
        },
        log,
        jobId,
      ),
    ),
  );

  const slots: ProviderSlot[] = settled.map((res, idx): ProviderSlot => {
    const provider = config.providers[idx];
    if (res.status === 'fulfilled') {
      const r: CallResult = res.value;
      return {
        provider,
        model: r.model,
        response: r.response,
        latencyMs: r.latencyMs,
        costCents: r.costCents,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      };
    }
    const reason = res.reason instanceof Error ? res.reason.message : String(res.reason);
    return {
      provider,
      model: DEFAULT_MODELS[provider],
      error: reason,
    };
  });

  let totalCostCents = slots.reduce((sum, s) => sum + (s.costCents ?? 0), 0);

  const successful = slots.filter((s) => !s.error && s.response);

  if (config.verdictMode === 'all') {
    return { providers: slots, totalCostCents };
  }

  if (successful.length === 0) {
    await log.error('multi.no_successful_responses');
    return {
      providers: slots,
      verdict: null,
      agreement: null,
      totalCostCents,
      error: 'all providers failed',
    };
  }

  if (config.verdictMode === 'best') {
    let best = successful[0];
    let bestLen = best.response?.length ?? 0;
    for (const s of successful.slice(1)) {
      const len = s.response?.length ?? 0;
      if (len > bestLen) { best = s; bestLen = len; }
    }
    return {
      providers: slots,
      verdict: best.response,
      verdictFrom: best.provider,
      agreement: null,
      totalCostCents,
    };
  }

  // consensus: synthesize via Claude
  const sections = successful.map((s) => `### ${s.provider} (${s.model})\n${s.response}`).join('\n\n');
  const synthesisPrompt =
    `You are reviewing answers from ${successful.length} AI providers to the same question.\n\n` +
    `Original question:\n${config.userPrompt}\n\n` +
    `Responses:\n${sections}\n\n` +
    `Tasks:\n` +
    `1. Identify the points of AGREEMENT across the responses.\n` +
    `2. Identify any points of DISAGREEMENT.\n` +
    `3. Produce a single synthesized verdict that best answers the original question.\n` +
    `4. Give an overall confidence score from 0.0 to 1.0.\n\n` +
    `Return ONLY valid JSON of the shape:\n` +
    `{"verdict": string, "agreement": string, "disagreement": string, "confidence": number}`;

  try {
    const synth = await callProvider(
      {
        provider: 'claude',
        userPrompt: synthesisPrompt,
        maxTokens: 1024,
        temperature: 0.2,
        jsonMode: true,
      },
      log,
      jobId,
    );
    totalCostCents += synth.costCents;
    let parsed: { verdict?: string; agreement?: string; disagreement?: string; confidence?: number } = {};
    try { parsed = JSON.parse(synth.response); } catch { /* fall through */ }
    return {
      providers: slots,
      verdict: parsed.verdict ?? synth.response,
      agreement: parsed.agreement ?? null,
      disagreement: parsed.disagreement ?? null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
      synthesisModel: synth.model,
      totalCostCents,
    };
  } catch (err) {
    const msg = err instanceof ProviderError ? err.message : (err as Error).message;
    await log.error('consensus.synthesis_failed', { error: msg });
    return {
      providers: slots,
      verdict: null,
      agreement: null,
      synthesisError: msg,
      totalCostCents,
    };
  }
};
