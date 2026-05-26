-- Phase 5a: Artifact.path → Artifact.storageKey (rename + normalize),
-- and add Artifact.storageProvider so we can tell where each blob lives.

-- Step 1: rename the column.
ALTER TABLE "Artifact" RENAME COLUMN "path" TO "storageKey";

-- Step 2: normalize values. The legacy `path` was an absolute filesystem path
-- of the form ${HIVE_ARTIFACT_DIR}/${jobId}/${filename}. The new key is
-- provider-relative (jobId/filename); the LocalFsStorageProvider re-joins it
-- with the configured base dir at read time.
UPDATE "Artifact"
SET "storageKey" = "jobId" || '/' || "filename";

-- Step 3: provider tag. Default is 'local' — existing files are on the local
-- FS; the migrate-artifacts-to-s3 script flips this per-row when invoked.
ALTER TABLE "Artifact"
ADD COLUMN "storageProvider" TEXT NOT NULL DEFAULT 'local';
