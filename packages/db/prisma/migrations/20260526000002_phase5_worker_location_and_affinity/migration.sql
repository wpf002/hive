-- Phase 5b: worker self-declared region/zone + template/bot dispatch affinity.

-- Worker: add region + zone with backwards-compatible defaults so single-host
-- deployments keep working without any env changes.
ALTER TABLE "Worker"
ADD COLUMN "region" TEXT NOT NULL DEFAULT 'local',
ADD COLUMN "zone"   TEXT NOT NULL DEFAULT 'default';

CREATE INDEX "Worker_poolType_region_zone_idx" ON "Worker"("poolType", "region", "zone");

-- BotTemplate.affinity: optional placement hint. Shape {region?, zone?}.
ALTER TABLE "BotTemplate" ADD COLUMN "affinity" JSONB;

-- Bot.affinityOverride: per-bot override of the template's affinity.
ALTER TABLE "Bot" ADD COLUMN "affinityOverride" JSONB;
