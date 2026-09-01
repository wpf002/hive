-- AlterTable
ALTER TABLE "AiUsage" ADD COLUMN     "costMicroCents" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "AiUsage_jobId_createdAt_idx" ON "AiUsage"("jobId", "createdAt");

