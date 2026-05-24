import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { JobLogger } from '@hive/worker-base-ts';
import { prisma } from '@hive/db';
import { type Provider, DEFAULT_MODELS, calculateCostCents } from './pricing.js';

export interface CallParams {
  provider: Provider;
  model?: string;
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

export interface CallResult {
  provider: Provider;
  model: string;
  response: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costCents: number;
}

const JSON_SUFFIX = '\n\nReturn ONLY valid JSON. No prose, no markdown fences.';

export class ProviderError extends Error {
  provider: Provider;
  constructor(provider: Provider, message: string) {
    super(message);
    this.provider = provider;
  }
}

function envKey(provider: Provider): string | undefined {
  switch (provider) {
    case 'claude': return process.env.ANTHROPIC_API_KEY || undefined;
    case 'gpt': return process.env.OPENAI_API_KEY || undefined;
    case 'perplexity': return process.env.PERPLEXITY_API_KEY || undefined;
  }
}

export async function callProvider(params: CallParams, log: JobLogger, jobId: string): Promise<CallResult> {
  const provider = params.provider;
  const model = params.model || DEFAULT_MODELS[provider];
  const maxTokens = params.maxTokens ?? 2048;
  const temperature = params.temperature ?? 0.7;
  const userPrompt = params.jsonMode ? params.userPrompt + JSON_SUFFIX : params.userPrompt;
  const systemPrompt = params.systemPrompt;

  const key = envKey(provider);
  if (!key) {
    throw new ProviderError(provider, `missing API key (env var for ${provider})`);
  }

  await log.info('ai.request', {
    provider,
    model,
    promptChars: userPrompt.length,
    systemChars: systemPrompt?.length ?? 0,
  });

  const t0 = Date.now();
  try {
    let result: { response: string; inputTokens: number; outputTokens: number };
    if (provider === 'claude') result = await callClaude({ key, model, systemPrompt, userPrompt, maxTokens, temperature });
    else if (provider === 'gpt') result = await callOpenAI({ key, model, systemPrompt, userPrompt, maxTokens, temperature, jsonMode: !!params.jsonMode });
    else result = await callPerplexity({ key, model, systemPrompt, userPrompt, maxTokens, temperature });

    const latencyMs = Date.now() - t0;
    const costCents = calculateCostCents(provider, model, result.inputTokens, result.outputTokens);

    await log.info('ai.response', {
      provider,
      model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs,
      costCents,
    });

    try {
      await prisma.aiUsage.create({
        data: {
          jobId,
          provider,
          model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costCents,
        },
      });
    } catch (err) {
      await log.warn('ai.usage_insert_failed', { error: (err as Error).message });
    }

    return {
      provider,
      model,
      response: result.response,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs,
      costCents,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log.error('ai.error', { provider, model, error: msg });
    throw new ProviderError(provider, msg);
  }
}

async function callClaude(args: {
  key: string; model: string; systemPrompt?: string; userPrompt: string; maxTokens: number; temperature: number;
}): Promise<{ response: string; inputTokens: number; outputTokens: number }> {
  const client = new Anthropic({ apiKey: args.key });
  const resp = await client.messages.create({
    model: args.model,
    max_tokens: args.maxTokens,
    temperature: args.temperature,
    system: args.systemPrompt,
    messages: [{ role: 'user', content: args.userPrompt }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return {
    response: text,
    inputTokens: resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
  };
}

async function callOpenAI(args: {
  key: string; model: string; systemPrompt?: string; userPrompt: string; maxTokens: number; temperature: number; jsonMode: boolean;
}): Promise<{ response: string; inputTokens: number; outputTokens: number }> {
  const client = new OpenAI({ apiKey: args.key });
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (args.systemPrompt) messages.push({ role: 'system', content: args.systemPrompt });
  messages.push({ role: 'user', content: args.userPrompt });

  const resp = await client.chat.completions.create({
    model: args.model,
    messages,
    max_tokens: args.maxTokens,
    temperature: args.temperature,
    ...(args.jsonMode ? { response_format: { type: 'json_object' } } : {}),
  });
  const text = resp.choices[0]?.message?.content ?? '';
  return {
    response: text,
    inputTokens: resp.usage?.prompt_tokens ?? 0,
    outputTokens: resp.usage?.completion_tokens ?? 0,
  };
}

async function callPerplexity(args: {
  key: string; model: string; systemPrompt?: string; userPrompt: string; maxTokens: number; temperature: number;
}): Promise<{ response: string; inputTokens: number; outputTokens: number }> {
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (args.systemPrompt) messages.push({ role: 'system', content: args.systemPrompt });
  messages.push({ role: 'user', content: args.userPrompt });

  const r = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.key}`,
    },
    body: JSON.stringify({
      model: args.model,
      messages,
      max_tokens: args.maxTokens,
      temperature: args.temperature,
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`perplexity HTTP ${r.status}: ${body.slice(0, 300)}`);
  }
  const data = (await r.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? '';
  return {
    response: text,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}
