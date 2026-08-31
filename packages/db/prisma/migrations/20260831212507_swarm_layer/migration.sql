-- CreateTable
CREATE TABLE "Mission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "limits" JSONB NOT NULL DEFAULT '{}',
    "allowedActions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approvalMode" TEXT NOT NULL DEFAULT 'manual',
    "lastDecisionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissionAgent" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "subscribes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MissionAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "jobId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hypothesis" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "supportingFindingIds" TEXT[],
    "independentSources" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Hypothesis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Challenge" (
    "id" TEXT NOT NULL,
    "hypothesisId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "objection" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "constraintResults" JSONB NOT NULL DEFAULT '[]',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "executedJobId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Mission_userId_status_idx" ON "Mission"("userId", "status");

-- CreateIndex
CREATE INDEX "Mission_status_idx" ON "Mission"("status");

-- CreateIndex
CREATE INDEX "MissionAgent_missionId_role_idx" ON "MissionAgent"("missionId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "MissionAgent_missionId_botId_role_key" ON "MissionAgent"("missionId", "botId", "role");

-- CreateIndex
CREATE INDEX "Finding_missionId_kind_observedAt_idx" ON "Finding"("missionId", "kind", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Finding_missionId_sourceId_contentHash_key" ON "Finding"("missionId", "sourceId", "contentHash");

-- CreateIndex
CREATE INDEX "Hypothesis_missionId_createdAt_idx" ON "Hypothesis"("missionId", "createdAt");

-- CreateIndex
CREATE INDEX "Hypothesis_missionId_independentSources_idx" ON "Hypothesis"("missionId", "independentSources");

-- CreateIndex
CREATE INDEX "Challenge_hypothesisId_idx" ON "Challenge"("hypothesisId");

-- CreateIndex
CREATE INDEX "Proposal_missionId_status_expiresAt_idx" ON "Proposal"("missionId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "Proposal_status_expiresAt_idx" ON "Proposal"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionAgent" ADD CONSTRAINT "MissionAgent_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionAgent" ADD CONSTRAINT "MissionAgent_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hypothesis" ADD CONSTRAINT "Hypothesis_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_hypothesisId_fkey" FOREIGN KEY ("hypothesisId") REFERENCES "Hypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
