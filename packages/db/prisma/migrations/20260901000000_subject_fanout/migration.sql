-- DropIndex
DROP INDEX "Finding_missionId_sourceId_contentHash_key";

-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "subject" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "MissionAgent" ADD COLUMN     "subject" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "Finding_missionId_subject_createdAt_idx" ON "Finding"("missionId", "subject", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Finding_missionId_sourceId_subject_contentHash_key" ON "Finding"("missionId", "sourceId", "subject", "contentHash");

-- CreateIndex
CREATE INDEX "MissionAgent_missionId_subject_idx" ON "MissionAgent"("missionId", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "MissionAgent_missionId_role_sourceId_subject_key" ON "MissionAgent"("missionId", "role", "sourceId", "subject");

