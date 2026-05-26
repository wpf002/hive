-- CreateTable
CREATE TABLE "KmsKey" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "KmsKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KmsKey_keyId_key" ON "KmsKey"("keyId");

-- CreateIndex
CREATE INDEX "KmsKey_status_idx" ON "KmsKey"("status");
