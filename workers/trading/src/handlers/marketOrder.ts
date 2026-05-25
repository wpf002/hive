import { z } from 'zod';
import { prisma, Prisma } from '@hive/db';
import type { Handler } from '@hive/worker-base-ts';
import { SUPPORTED_EXCHANGES, publicExchange, authedExchange } from '../exchanges.js';
import { liveTradingEnabled } from '../env.js';
import { writeAudit } from '../audit.js';

const Config = z.object({
  exchange: z.enum(SUPPORTED_EXCHANGES),
  symbol: z.string().regex(/^[A-Z0-9._-]+\/[A-Z0-9._-]+$/, 'symbol must be like BTC/USDT'),
  side: z.enum(['buy', 'sell']),
  amount: z.number().positive(),
  mode: z.enum(['paper', 'live']).default('paper'),
  apiKey: z.string().optional(),
  apiSecret: z.string().optional(),
  maxSlippagePct: z.number().nonnegative().default(1.0),
});

function splitSymbol(symbol: string): { base: string; quote: string } {
  const [base, quote] = symbol.split('/');
  return { base, quote };
}

async function getOrCreateWallet(
  exchange: string,
  currency: string,
): Promise<{ id: string; balance: Prisma.Decimal }> {
  const existing = await prisma.paperWallet.findUnique({
    where: { exchange_currency: { exchange, currency } },
  });
  if (existing) return { id: existing.id, balance: existing.balance };
  const created = await prisma.paperWallet.create({
    data: { exchange, currency, balance: new Prisma.Decimal(0) },
  });
  return { id: created.id, balance: created.balance };
}

export const marketOrderHandler: Handler = async (rawConfig, { jobId, botId, log }) => {
  const cfg = Config.parse(rawConfig);

  if (cfg.mode === 'live') {
    if (!liveTradingEnabled()) {
      await log.error('trading.live_refused', {
        reason: 'TRADING_LIVE_ENABLED env var is not "true"',
      });
      await writeAudit({
        jobId,
        botId,
        mode: 'live',
        action: 'order.refused',
        payload: { exchange: cfg.exchange, symbol: cfg.symbol, side: cfg.side, amount: cfg.amount },
        result: { ok: false, error: 'TRADING_LIVE_ENABLED is not true' },
      });
      throw new Error(
        'LIVE trading is disabled — set TRADING_LIVE_ENABLED=true on the trading worker to enable. Refusing before any exchange call.',
      );
    }
    await log.warn('trading.LIVE', {
      message: 'live mode order beginning',
      exchange: cfg.exchange,
      symbol: cfg.symbol,
      side: cfg.side,
      amount: cfg.amount,
    });
    await writeAudit({
      jobId,
      botId,
      mode: 'live',
      action: 'order.starting',
      payload: { exchange: cfg.exchange, symbol: cfg.symbol, side: cfg.side, amount: cfg.amount },
      result: { ok: true, stage: 'pre-exchange' },
    });
    if (!cfg.apiKey || !cfg.apiSecret) {
      throw new Error('live mode requires apiKey + apiSecret in bot config');
    }
  }

  // Always fetch a real ticker — paper-mode prices track reality.
  const pub = publicExchange(cfg.exchange);
  await log.info('trading.ticker_fetch', { exchange: cfg.exchange, symbol: cfg.symbol });
  let ticker;
  try {
    ticker = await pub.fetchTicker(cfg.symbol);
  } catch (err) {
    throw new Error(`ccxt fetchTicker failed: ${(err as Error).message}`);
  }
  const quotePrice = ticker.last ?? ticker.close ?? ticker.bid;
  if (typeof quotePrice !== 'number' || !isFinite(quotePrice) || quotePrice <= 0) {
    throw new Error(`exchange returned no usable price for ${cfg.symbol}`);
  }

  const { base, quote } = splitSymbol(cfg.symbol);

  if (cfg.mode === 'paper') {
    // Read wallets and atomically adjust within a transaction.
    const spendCurrency = cfg.side === 'buy' ? quote : base;
    const receiveCurrency = cfg.side === 'buy' ? base : quote;
    const spendAmount =
      cfg.side === 'buy' ? new Prisma.Decimal(quotePrice).mul(cfg.amount) : new Prisma.Decimal(cfg.amount);
    const receiveAmount =
      cfg.side === 'buy' ? new Prisma.Decimal(cfg.amount) : new Prisma.Decimal(quotePrice).mul(cfg.amount);

    const { trade, walletAfter } = await prisma.$transaction(async (tx) => {
      const spendWallet = await tx.paperWallet.findUnique({
        where: { exchange_currency: { exchange: cfg.exchange, currency: spendCurrency } },
      });
      if (!spendWallet || spendWallet.balance.lessThan(spendAmount)) {
        throw new Error(
          `insufficient paper balance: need ${spendAmount.toString()} ${spendCurrency} on ${cfg.exchange}, have ${spendWallet?.balance.toString() ?? '0'} — seed via POST /api/paper-wallet/seed`,
        );
      }
      const newSpendBal = spendWallet.balance.minus(spendAmount);
      await tx.paperWallet.update({
        where: { id: spendWallet.id },
        data: { balance: newSpendBal },
      });
      // Top up receive wallet (create if missing).
      const recv = await tx.paperWallet.findUnique({
        where: { exchange_currency: { exchange: cfg.exchange, currency: receiveCurrency } },
      });
      const newRecvBal = (recv?.balance ?? new Prisma.Decimal(0)).plus(receiveAmount);
      if (recv) {
        await tx.paperWallet.update({ where: { id: recv.id }, data: { balance: newRecvBal } });
      } else {
        await tx.paperWallet.create({
          data: { exchange: cfg.exchange, currency: receiveCurrency, balance: newRecvBal, botId },
        });
      }
      const tradeRow = await tx.paperTrade.create({
        data: {
          jobId,
          exchange: cfg.exchange,
          symbol: cfg.symbol,
          side: cfg.side,
          type: 'market',
          amount: new Prisma.Decimal(cfg.amount),
          price: new Prisma.Decimal(quotePrice),
          status: 'filled',
          executedPrice: new Prisma.Decimal(quotePrice),
        },
      });
      return { trade: tradeRow, walletAfter: { spend: newSpendBal.toString(), receive: newRecvBal.toString() } };
    });

    const result = {
      mode: 'paper' as const,
      exchange: cfg.exchange,
      symbol: cfg.symbol,
      side: cfg.side,
      amount: cfg.amount,
      fillPrice: quotePrice,
      totalCost: spendAmount.toString(),
      spendCurrency,
      receiveCurrency,
      walletBalanceAfter: walletAfter,
      tradeId: trade.id,
    };
    await writeAudit({
      jobId,
      botId,
      mode: 'paper',
      action: 'order.filled',
      payload: { exchange: cfg.exchange, symbol: cfg.symbol, side: cfg.side, amount: cfg.amount, quotePrice },
      result,
    });
    await log.info('trading.paper.filled', result);
    return result;
  }

  // ---- live mode ----
  const ex = authedExchange(cfg.exchange, cfg.apiKey!, cfg.apiSecret!);
  let order;
  try {
    order = await ex.createMarketOrder(cfg.symbol, cfg.side, cfg.amount);
  } catch (err) {
    await writeAudit({
      jobId,
      botId,
      mode: 'live',
      action: 'order.error',
      payload: { exchange: cfg.exchange, symbol: cfg.symbol, side: cfg.side, amount: cfg.amount },
      result: { ok: false, error: (err as Error).message },
    });
    throw new Error(`live order failed: ${(err as Error).message}`);
  }

  const fillPrice = (order.average ?? order.price ?? quotePrice) as number;
  const slippagePct = ((fillPrice - quotePrice) / quotePrice) * 100;
  if (Math.abs(slippagePct) > cfg.maxSlippagePct) {
    await log.warn('trading.live.slippage_exceeded', { slippagePct, maxSlippagePct: cfg.maxSlippagePct });
  }

  const result = {
    mode: 'live' as const,
    exchange: cfg.exchange,
    symbol: cfg.symbol,
    side: cfg.side,
    amount: cfg.amount,
    fillPrice,
    quotePrice,
    slippagePct,
    exchangeOrderId: order.id,
    status: order.status ?? 'filled',
  };
  await writeAudit({
    jobId,
    botId,
    mode: 'live',
    action: 'order.filled',
    payload: { exchange: cfg.exchange, symbol: cfg.symbol, side: cfg.side, amount: cfg.amount, quotePrice },
    result,
  });
  await log.info('trading.live.filled', result);
  return result;
};
