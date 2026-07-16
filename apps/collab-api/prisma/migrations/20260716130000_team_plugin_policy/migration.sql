CREATE TABLE "TeamPluginPolicy" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "activeRevisionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TeamPluginPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TeamPluginPolicyRevision" (
  "id" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "enforcementMode" TEXT NOT NULL DEFAULT 'ENFORCE',
  "document" JSONB NOT NULL,
  "documentSha256" TEXT NOT NULL,
  "createdById" TEXT,
  "sourceRevisionId" TEXT,
  "changeReason" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamPluginPolicyRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeamPluginPolicy_teamId_key" ON "TeamPluginPolicy"("teamId");
CREATE UNIQUE INDEX "TeamPluginPolicy_activeRevisionId_key" ON "TeamPluginPolicy"("activeRevisionId");
CREATE UNIQUE INDEX "TeamPluginPolicyRevision_teamId_revision_key" ON "TeamPluginPolicyRevision"("teamId", "revision");
CREATE INDEX "TeamPluginPolicyRevision_policyId_createdAt_idx" ON "TeamPluginPolicyRevision"("policyId", "createdAt");
CREATE INDEX "TeamPluginPolicyRevision_sourceRevisionId_idx" ON "TeamPluginPolicyRevision"("sourceRevisionId");
ALTER TABLE "TeamPluginPolicy" ADD CONSTRAINT "TeamPluginPolicy_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamPluginPolicyRevision" ADD CONSTRAINT "TeamPluginPolicyRevision_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "TeamPluginPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamPluginPolicyRevision" ADD CONSTRAINT "TeamPluginPolicyRevision_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamPluginPolicyRevision" ADD CONSTRAINT "TeamPluginPolicyRevision_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TeamPluginPolicy" ADD CONSTRAINT "TeamPluginPolicy_activeRevisionId_fkey" FOREIGN KEY ("activeRevisionId") REFERENCES "TeamPluginPolicyRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
