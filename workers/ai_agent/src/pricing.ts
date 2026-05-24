export type Provider = 'claude' | 'gpt' | 'perplexity';

export const DEFAULT_MODELS: Record<Provider, string> = {
  claude: 'claude-sonnet-4-5',
  gpt: 'gpt-4o',
  perplexity: 'sonar-pro',
};

interface Pricing {
  inPerM: number;  // cents per million input tokens
  outPerM: number; // cents per million output tokens
}

const TABLE: Record<string, Pricing> = {
  'claude-sonnet-4-5': { inPerM: 300, outPerM: 1500 },
  'gpt-4o': { inPerM: 250, outPerM: 1000 },
  'sonar-pro': { inPerM: 300, outPerM: 1500 },
};

// Fallback per-provider when the specific model isn't in the table.
const PROVIDER_FALLBACK: Record<Provider, Pricing> = {
  claude: TABLE['claude-sonnet-4-5'],
  gpt: TABLE['gpt-4o'],
  perplexity: TABLE['sonar-pro'],
};

export function calculateCostCents(
  provider: Provider,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = TABLE[model] ?? PROVIDER_FALLBACK[provider];
  const inCents = (inputTokens / 1_000_000) * pricing.inPerM;
  const outCents = (outputTokens / 1_000_000) * pricing.outPerM;
  return Math.floor(inCents + outCents);
}
