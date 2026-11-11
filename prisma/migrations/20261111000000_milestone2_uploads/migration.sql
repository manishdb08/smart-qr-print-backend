-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('pending_upload', 'uploaded', 'validating', 'ready', 'rejected', 'malware_suspected');

-- CreateEnum
CREATE TYPE "UploadSessionStatus" AS ENUM ('pending', 'completed', 'expired', 'cancelled');

-- AlterTable DocumentAsset
ALTER TABLE "DocumentAsset" ADD COLUMN IF NOT EXISTS "status" "AssetStatus" NOT NULL DEFAULT 'pending_upload';
ALTER TABLE "DocumentAsset" ADD COLUMN IF NOT EXISTS "width" INTEGER;
ALTER TABLE "DocumentAsset" ADD COLUMN IF NOT EXISTS "height" INTEGER;
ALTER TABLE "DocumentAsset" ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DocumentAsset" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "DocumentAsset" ALTER COLUMN "checksumSha256" DROP NOT NULL;
ALTER TABLE "DocumentAsset" ALTER COLUMN "fileSizeBytes" DROP NOT NULL;
ALTER TABLE "DocumentAsset" ALTER COLUMN "pageCount" DROP NOT NULL;

-- AlterTable AssetVersion
ALTER TABLE "AssetVersion" ADD COLUMN IF NOT EXISTS "operationType" TEXT;
ALTER TABLE "AssetVersion" ADD COLUMN IF NOT EXISTS "sourceVersionId" TEXT;
ALTER TABLE "AssetVersion" ADD COLUMN IF NOT EXISTS "width" INTEGER;
ALTER TABLE "AssetVersion" ADD COLUMN IF NOT EXISTS "height" INTEGER;
ALTER TABLE "AssetVersion" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE "AssetVersion" ADD COLUMN IF NOT EXISTS "createdById" TEXT;

-- CreateTable UploadSession
CREATE TABLE IF NOT EXISTS "UploadSession" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "declaredMimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" "UploadSessionStatus" NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "UploadSession_storageKey_key" ON "UploadSession"("storageKey");
CREATE UNIQUE INDEX IF NOT EXISTS "UploadSession_idempotencyKey_key" ON "UploadSession"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "UploadSession_assetId_idx" ON "UploadSession"("assetId");
CREATE INDEX IF NOT EXISTS "UploadSession_userId_idx" ON "UploadSession"("userId");
CREATE INDEX IF NOT EXISTS "UploadSession_status_expiresAt_idx" ON "UploadSession"("status", "expiresAt");
CREATE INDEX IF NOT EXISTS "DocumentAsset_status_idx" ON "DocumentAsset"("status");
CREATE INDEX IF NOT EXISTS "DocumentAsset_isDeleted_idx" ON "DocumentAsset"("isDeleted");

-- AddForeignKey
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "DocumentAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
