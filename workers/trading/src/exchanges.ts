import ccxt, { type Exchange } from 'ccxt';

export const SUPPORTED_EXCHANGES = ['binance', 'coinbase', 'kraken'] as const;
export type ExchangeId = (typeof SUPPORTED_EXCHANGES)[number];

const _publicCache = new Map<ExchangeId, Exchange>();

/** Public (read-only) ccxt client — used for ticker fetches in both paper & live modes. */
export function publicExchange(id: ExchangeId): Exchange {
  let ex = _publicCache.get(id);
  if (!ex) {
    const Ctor = (ccxt as unknown as Record<string, new (opts?: object) => Exchange>)[id];
    if (!Ctor) throw new Error(`ccxt does not support exchange '${id}'`);
    ex = new Ctor({ enableRateLimit: true });
    _publicCache.set(id, ex);
  }
  return ex;
}

/** Per-call authenticated client (not cached — keys may differ per job). */
export function authedExchange(id: ExchangeId, apiKey: string, apiSecret: string): Exchange {
  const Ctor = (ccxt as unknown as Record<string, new (opts?: object) => Exchange>)[id];
  if (!Ctor) throw new Error(`ccxt does not support exchange '${id}'`);
  return new Ctor({ apiKey, secret: apiSecret, enableRateLimit: true });
}
