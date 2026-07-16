CREATE TABLE "WebPreviewSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "releaseId" TEXT NOT NULL,
  "releaseSha256" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "nonceSha256" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebPreviewSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebPreviewSession_nonceSha256_key" ON "WebPreviewSession"("nonceSha256");
CREATE INDEX "WebPreviewSession_userId_teamId_expiresAt_idx" ON "WebPreviewSession"("userId", "teamId", "expiresAt");
CREATE INDEX "WebPreviewSession_releaseId_expiresAt_idx" ON "WebPreviewSession"("releaseId", "expiresAt");
ALTER TABLE "WebPreviewSession" ADD CONSTRAINT "WebPreviewSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebPreviewSession" ADD CONSTRAINT "WebPreviewSession_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebPreviewSession" ADD CONSTRAINT "WebPreviewSession_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "PluginRelease"("id") ON DELETE CASCADE ON UPDATE CASCADE;
