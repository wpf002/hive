import { z } from 'zod';
import { prisma } from '@hive/db';
import type { Handler } from '@hive/worker-base-ts';
import { SUPPORTED_EXCHANGES, publicExchange, authedExchange, type ExchangeId } from '../exchanges.js';
import { liveTradingEnabled } from '../env.js';

const Config = z.object({
  exchange: z.enum(SUPPORTED_EXCHANGES),
  mode: z.enum(['paper', 'live']).default('paper'),
  apiKey: z.string().optional(),
  apiSecret: z.string().optional(),
  symbols: z.array(z.string()).optional(),
  includeUsd: z.boolean().default(true),
});

interface BalanceRow {
  currency: string;
  total: number;
  usdValue?: number;
}

async function usdValue(exchange: ExchangeId, currency: string, amount: number): Promise<number | undefined> {
  if (amount === 0) return 0;
  const cu = currency.toUpperCase();
  if (cu === 'USD' || cu === 'USDT' || cu === 'USDC' || cu === 'BUSD' || cu === 'DAI') return amount;
  const pub = publicExchange(exchange);
  for (const quote of ['USDT', 'USD', 'USDC']) {
    const sym = `${cu}/${quote}`;
    try {
      const t = await pub.fetchTicker(sym);
      const px = t.last ?? t.close ?? t.bid;
      if (typeof px === 'number' && px > 0) return amount * px;
    } catch {
      // try next quote
    }
  }
  return undefined;
}

export const portfolioSnapshotHandler: Handler = async (rawConfig, { log }) => {
  const cfg = Config.parse(rawConfig);

  if (cfg.mode === 'live' && !liveTradingEnabled()) {
    throw new Error(
      'LIVE trading is disabled — set TRADING_LIVE_ENABLED=true on the trading worker to fetch live balances.',
    );
  }

  const balances: BalanceRow[] = [];
  if (cfg.mode === 'paper') {
    const wallets = await prisma.paperWallet.findMany({ where: { exchange: cfg.exchange } });
    for (const w of wallets) {
      if (cfg.symbols && cfg.symbols.length && !cfg.symbols.includes(w.currency)) continue;
      const total = Number(w.balance);
      const row: BalanceRow = { currency: w.currency, total };
      if (cfg.includeUsd) {
        row.usdValue = await usdValue(cfg.exchange, w.currency, total);
      }
      balances.push(row);
    }
  } else {
    if (!cfg.apiKey || !cfg.apiSecret) {
      throw new Error('live mode requires apiKey + apiSecret');
    }
    const ex = authedExchange(cfg.exchange, cfg.apiKey, cfg.apiSecret);
    const bal = await ex.fetchBalance();
    const totals = (bal.total ?? {}) as unknown as Record<string, number>;
    for (const [currency, total] of Object.entries(totals)) {
      if (!total) continue;
      if (cfg.symbols && cfg.symbols.length && !cfg.symbols.includes(currency)) continue;
      const row: BalanceRow = { currency, total };
      if (cfg.includeUsd) row.usdValue = await usdValue(cfg.exchange, currency, total);
      balances.push(row);
    }
  }

  const totalUsdValue = balances.reduce((s, b) => s + (b.usdValue ?? 0), 0);
  const result = {
    mode: cfg.mode,
    exchange: cfg.exchange,
    balances,
    totalUsdValue,
    snapshotAt: new Date().toISOString(),
  };
  await log.info('trading.snapshot', { mode: cfg.mode, currencies: balances.length, totalUsdValue });
  return result;
};
