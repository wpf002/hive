-- AlterTable
ALTER TABLE "User" ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'free',
ADD COLUMN     "quotaDailySpendCents" INTEGER,
ADD COLUMN     "quotaMaxBots" INTEGER,
ADD COLUMN     "quotaMaxMissions" INTEGER;

