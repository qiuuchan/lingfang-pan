CREATE TYPE "DesktopExecutorSessionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

ALTER TABLE "WorkflowRun"
  ADD COLUMN "desktopExecutorSessionId" TEXT,
  ADD COLUMN "desktopInventorySha256" TEXT;

ALTER TABLE "WorkflowStepAttempt"
  ADD COLUMN "leaseTokenSha256" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "leaseHeartbeatAt" TIMESTAMP(3);

CREATE TABLE "DesktopExecutorSession" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "inventorySchemaVersion" TEXT NOT NULL DEFAULT '1',
  "inventorySha256" TEXT NOT NULL,
  "inventory" JSONB NOT NULL,
  "tokenSha256" TEXT NOT NULL,
  "status" "DesktopExecutorSessionStatus" NOT NULL DEFAULT 'ACTIVE',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastHeartbeatAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DesktopExecutorSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DesktopExecutorSession_tokenSha256_key"
  ON "DesktopExecutorSession"("tokenSha256");
CREATE UNIQUE INDEX "DesktopExecutorSession_id_teamId_inventorySha256_key"
  ON "DesktopExecutorSession"("id", "teamId", "inventorySha256");
CREATE INDEX "DesktopExecutorSession_teamId_userId_status_expiresAt_idx"
  ON "DesktopExecutorSession"("teamId", "userId", "status", "expiresAt");
CREATE INDEX "DesktopExecutorSession_deviceId_status_idx"
  ON "DesktopExecutorSession"("deviceId", "status");
CREATE INDEX "WorkflowStepAttempt_runId_leaseExpiresAt_idx"
  ON "WorkflowStepAttempt"("runId", "leaseExpiresAt");
CREATE INDEX "WorkflowRun_desktopExecutorSessionId_idx"
  ON "WorkflowRun"("desktopExecutorSessionId");

ALTER TABLE "DesktopExecutorSession"
  ADD CONSTRAINT "DesktopExecutorSession_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DesktopExecutorSession"
  ADD CONSTRAINT "DesktopExecutorSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowRun"
  ADD CONSTRAINT "WorkflowRun_desktopExecutorSession_fkey"
  FOREIGN KEY ("desktopExecutorSessionId", "teamId", "desktopInventorySha256")
  REFERENCES "DesktopExecutorSession"("id", "teamId", "inventorySha256") ON DELETE RESTRICT ON UPDATE CASCADE;
