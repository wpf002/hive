-- CreateTable
CREATE TABLE "DigestRun" (
    "id" TEXT NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "failingBots" JSONB NOT NULL,
    "lessonsLearned" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DigestRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DigestRun_windowEnd_key" ON "DigestRun"("windowEnd");

-- CreateIndex
CREATE INDEX "DigestRun_createdAt_idx" ON "DigestRun"("createdAt");
