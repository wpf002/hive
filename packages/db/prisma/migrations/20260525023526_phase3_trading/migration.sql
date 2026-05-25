-- CreateTable
CREATE TABLE "PaperWallet" (
    "id" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "balance" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "botId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaperWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperTrade" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "price" DECIMAL(18,8),
    "status" TEXT NOT NULL,
    "executedPrice" DECIMAL(18,8),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeAudit" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaperWallet_botId_idx" ON "PaperWallet"("botId");

-- CreateIndex
CREATE UNIQUE INDEX "PaperWallet_exchange_currency_key" ON "PaperWallet"("exchange", "currency");

-- CreateIndex
CREATE INDEX "PaperTrade_jobId_idx" ON "PaperTrade"("jobId");

-- CreateIndex
CREATE INDEX "PaperTrade_symbol_createdAt_idx" ON "PaperTrade"("symbol", "createdAt");

-- CreateIndex
CREATE INDEX "TradeAudit_botId_createdAt_idx" ON "TradeAudit"("botId", "createdAt");

-- CreateIndex
CREATE INDEX "TradeAudit_mode_createdAt_idx" ON "TradeAudit"("mode", "createdAt");

-- CreateIndex
CREATE INDEX "TradeAudit_jobId_idx" ON "TradeAudit"("jobId");
