-- 应用版本发布 + 产物：官网展示 / 桌面端检查更新用（platform 级，平台 Admin 维护）。

-- CreateEnum
CREATE TYPE "ReleaseChannel" AS ENUM ('STABLE', 'BETA');

-- CreateEnum
CREATE TYPE "ReleaseStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AssetPlatform" AS ENUM ('WINDOWS', 'DARWIN', 'LINUX');

-- CreateEnum
CREATE TYPE "AssetArch" AS ENUM ('X86_64', 'AARCH64', 'UNIVERSAL');

-- CreateTable
CREATE TABLE "Release" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "channel" "ReleaseChannel" NOT NULL DEFAULT 'STABLE',
    "status" "ReleaseStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "isLatest" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReleaseAsset" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "platform" "AssetPlatform" NOT NULL,
    "arch" "AssetArch" NOT NULL,
    "url" TEXT NOT NULL,
    "filename" TEXT NOT NULL DEFAULT '',
    "signature" TEXT NOT NULL DEFAULT '',
    "sizeBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReleaseAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Release_channel_version_key" ON "Release"("channel", "version");

-- CreateIndex
CREATE INDEX "Release_channel_status_isLatest_idx" ON "Release"("channel", "status", "isLatest");

-- CreateIndex
CREATE INDEX "Release_channel_status_publishedAt_idx" ON "Release"("channel", "status", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReleaseAsset_releaseId_platform_arch_key" ON "ReleaseAsset"("releaseId", "platform", "arch");

-- CreateIndex
CREATE INDEX "ReleaseAsset_releaseId_idx" ON "ReleaseAsset"("releaseId");

-- AddForeignKey
ALTER TABLE "ReleaseAsset" ADD CONSTRAINT "ReleaseAsset_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;
