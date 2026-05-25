import { WorkerBase } from '@hive/worker-base-ts';
import { env, liveTradingEnabled } from './env.js';
import { marketOrderHandler } from './handlers/marketOrder.js';
import { portfolioSnapshotHandler } from './handlers/portfolioSnapshot.js';
import { arbitrageWatcherHandler } from './handlers/arbitrageWatcher.js';

export const MARKET_ORDER = 'Trading Market Order';
export const PORTFOLIO_SNAPSHOT = 'Trading Portfolio Snapshot';
export const ARBITRAGE_WATCHER = 'Arbitrage Watcher';

class TradingWorker extends WorkerBase {
  constructor() {
    super({
      poolType: 'trading',
      capacity: 4, // intentionally low — real-money trading is not parallel-friendly
      maxAttempts: 1, // no automatic retries for trading
      apiBaseUrl: env.API_BASE_URL,
      workerAuthToken: env.WORKER_AUTH_TOKEN,
      redisUrl: env.REDIS_URL,
    });
  }

  protected async setup(): Promise<void> {
    this.register(MARKET_ORDER, marketOrderHandler);
    this.register(PORTFOLIO_SNAPSHOT, portfolioSnapshotHandler);
    this.register(ARBITRAGE_WATCHER, arbitrageWatcherHandler);
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        service: 'worker-trading',
        event: 'trading.mode',
        liveEnabled: liveTradingEnabled(),
      }),
    );
  }
}

await new TradingWorker().run();
