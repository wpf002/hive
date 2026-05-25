# Trading pool

The trading pool runs as a TypeScript worker built on `@hive/worker-base-ts`
and `ccxt`. It supports two execution modes per bot:

- **`paper` (default)** — All orders are simulated against rows in the
  `PaperWallet` table. No real exchange calls are made for *order placement*;
  ticker prices are always fetched from the real exchange so paper fills track
  market reality.
- **`live`** — Real exchange calls via `ccxt` using API keys stored in the
  bot's config. **Refused** unless the trading worker is started with
  `TRADING_LIVE_ENABLED=true`. Logged loudly. Every action — paper or live —
  records an immutable `TradeAudit` row.

## Templates

1. **Trading Market Order** — Buy/sell at market. In paper, deducts from
   `PaperWallet` (insufficient balance → job fails with clear error). In live,
   places a real market order and surfaces ccxt errors verbatim.
2. **Trading Portfolio Snapshot** — Read-only balances. Paper reads
   `PaperWallet`; live calls `ccxt.fetchBalance()`. Includes USD valuation
   from the same exchange's ticker when `includeUsd=true`.
3. **Arbitrage Watcher** — Read-only across 2+ exchanges. Polls tickers every
   5 s for `durationSeconds`. Logs every observation, flags spreads ≥
   `minSpreadPct`, and optionally POSTs JSON to `alertWebhookUrl`. Never
   auto-executes trades.

## Opting in to live mode

1. **Set the env var on the trading worker process:**
   ```
   TRADING_LIVE_ENABLED=true pnpm --filter @hive/worker-trading dev
   ```
   Or add to `.env` and restart the worker. The API also reads this flag so the
   UI can render the site-wide red banner.

2. **Create a bot with `mode: 'live'`** and populate `apiKey` + `apiSecret` in
   its config. The API masks these on subsequent GET responses (only the last
   4 chars are visible).

3. **The first live job will log `trading.LIVE`** at warn level and write an
   extra `TradeAudit` row at `order.starting` *before* any exchange call.

## Key rotation

Keys live in `Bot.config` as plain JSON columns. To rotate:

```bash
curl -X PATCH https://hive/api/bots/$BOT \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"config":{"...":"...","apiKey":"NEW","apiSecret":"NEW"}}'
```

**Phase 4 will encrypt secrets at rest** with libsodium or pgcrypto. Until
then, treat `Bot.config` rows as you would `.env` — restrict DB read access.

## Audit log retention

`TradeAudit` is append-only. No retention policy is set; rows accumulate
forever. For prod, schedule a periodic prune (`DELETE FROM "TradeAudit" WHERE
"createdAt" < now() - interval '180 days'`) once trading volume warrants it.
The UI's audit tab paginates with `?limit=` (max 500).

## Paper wallet seeding

```bash
curl -X POST https://hive/api/paper-wallet/seed \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"exchange":"binance","currency":"USDT","amount":10000}'
```

Or via the Trading → Paper Wallets tab in the UI. Seeding is additive — a
second call with `amount: 5000` on the same `(exchange, currency)` tops the
wallet up to 15 000.
