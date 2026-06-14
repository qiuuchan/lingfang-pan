-- CreateEnum
CREATE TYPE "LlmGatewayStatus" AS ENUM ('ENABLED', 'DISABLED');

-- CreateTable
CREATE TABLE "LlmGateway" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "apiUrl" TEXT NOT NULL,
    "status" "LlmGatewayStatus" NOT NULL DEFAULT 'ENABLED',
    "models" JSONB NOT NULL DEFAULT '[]',
    "description" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmGateway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantLlmBinding" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "gatewayId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "apiKeyHint" TEXT NOT NULL DEFAULT '',
    "keyFingerprint" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "modelOverride" JSONB,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantLlmBinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LlmGateway_name_key" ON "LlmGateway"("name");

-- CreateIndex
CREATE INDEX "LlmGateway_status_sortOrder_idx" ON "LlmGateway"("status", "sortOrder");

-- CreateIndex
CREATE INDEX "TenantLlmBinding_teamId_enabled_idx" ON "TenantLlmBinding"("teamId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "TenantLlmBinding_teamId_gatewayId_key" ON "TenantLlmBinding"("teamId", "gatewayId");

-- AddForeignKey
ALTER TABLE "TenantLlmBinding" ADD CONSTRAINT "TenantLlmBinding_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantLlmBinding" ADD CONSTRAINT "TenantLlmBinding_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "LlmGateway"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantLlmBinding" ADD CONSTRAINT "TenantLlmBinding_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantLlmBinding" ADD CONSTRAINT "TenantLlmBinding_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
