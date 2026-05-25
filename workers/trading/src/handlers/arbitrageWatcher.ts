import { z } from 'zod';
import type { Handler } from '@hive/worker-base-ts';
import { SUPPORTED_EXCHANGES, publicExchange, type ExchangeId } from '../exchanges.js';

const Config = z.object({
  exchanges: z.array(z.enum(SUPPORTED_EXCHANGES)).min(2),
  symbol: z.string().regex(/^[A-Z0-9._-]+\/[A-Z0-9._-]+$/),
  minSpreadPct: z.number().nonnegative().default(0.5),
  durationSeconds: z.number().int().min(5).max(3600).default(300),
  alertWebhookUrl: z.string().url().optional(),
});

const POLL_INTERVAL_MS = 5000;

interface Detection {
  spreadPct: number;
  exchanges: Array<{ name: string; price: number }>;
  detectedAt: string;
}

async function fetchPrice(exchange: ExchangeId, symbol: string): Promise<number | null> {
  try {
    const t = await publicExchange(exchange).fetchTicker(symbol);
    const px = t.last ?? t.close ?? t.bid;
    return typeof px === 'number' && px > 0 ? px : null;
  } catch {
    return null;
  }
}

export const arbitrageWatcherHandler: Handler = async (rawConfig, { log }) => {
  const cfg = Config.parse(rawConfig);
  // Dedupe exchanges in case the same one is listed twice.
  const exchanges = Array.from(new Set(cfg.exchanges)) as ExchangeId[];
  if (exchanges.length < 2) throw new Error('need at least 2 distinct exchanges');

  const startedAt = Date.now();
  const detections: Detection[] = [];
  let observations = 0;
  let maxSpreadPct = 0;

  await log.info('arbitrage.start', {
    exchanges,
    symbol: cfg.symbol,
    durationSeconds: cfg.durationSeconds,
    minSpreadPct: cfg.minSpreadPct,
  });

  while (Date.now() - startedAt < cfg.durationSeconds * 1000) {
    const prices: Array<{ name: ExchangeId; price: number }> = [];
    for (const ex of exchanges) {
      const p = await fetchPrice(ex, cfg.symbol);
      if (p != null) prices.push({ name: ex, price: p });
    }
    if (prices.length >= 2) {
      observations += 1;
      const min = Math.min(...prices.map((p) => p.price));
      const max = Math.max(...prices.map((p) => p.price));
      const spreadPct = ((max - min) / min) * 100;
      maxSpreadPct = Math.max(maxSpreadPct, spreadPct);
      await log.info('arbitrage.observation', {
        spreadPct: Number(spreadPct.toFixed(4)),
        prices: prices.map((p) => ({ name: p.name, price: p.price })),
      });
      if (spreadPct >= cfg.minSpreadPct) {
        const detection: Detection = {
          spreadPct,
          exchanges: prices,
          detectedAt: new Date().toISOString(),
        };
        detections.push(detection);
        await log.warn('arbitrage.detection', { ...detection });
        if (cfg.alertWebhookUrl) {
          try {
            await fetch(cfg.alertWebhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ symbol: cfg.symbol, ...detection }),
              signal: AbortSignal.timeout(5000),
            });
          } catch (err) {
            await log.error('arbitrage.webhook_failed', { error: (err as Error).message });
          }
        }
      }
    } else {
      await log.warn('arbitrage.no_quorum', { gotPrices: prices.length });
    }
    const remaining = cfg.durationSeconds * 1000 - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(POLL_INTERVAL_MS, remaining)));
  }

  return {
    symbol: cfg.symbol,
    durationSeconds: cfg.durationSeconds,
    observations,
    detections,
    maxSpreadPct,
    exitedAt: new Date().toISOString(),
  };
};
