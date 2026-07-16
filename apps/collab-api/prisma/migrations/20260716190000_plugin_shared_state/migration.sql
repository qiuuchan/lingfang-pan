CREATE TYPE "SharedNamespaceOwnerKind" AS ENUM ('PACKAGE', 'WORKFLOW');
CREATE TYPE "SharedChangeEventKind" AS ENUM ('UPSERT', 'DELETE');

CREATE TABLE "PluginSharedNamespace" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "ownerKind" "SharedNamespaceOwnerKind" NOT NULL,
  "ownerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "deletedAt" TIMESTAMP(3),
  "activeSchemaVersion" INTEGER NOT NULL DEFAULT 1,
  "nextValueRevision" BIGINT NOT NULL DEFAULT 0,
  "nextChangeCursor" BIGINT NOT NULL DEFAULT 0,
  "usedBytes" INTEGER NOT NULL DEFAULT 0,
  "quotaBytes" INTEGER NOT NULL DEFAULT 10485760,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PluginSharedNamespace_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PluginSharedNamespace_teamId_ownerKind_ownerId_name_key" ON "PluginSharedNamespace"("teamId", "ownerKind", "ownerId", "name");
CREATE INDEX "PluginSharedNamespace_teamId_deletedAt_idx" ON "PluginSharedNamespace"("teamId", "deletedAt");
CREATE INDEX "PluginSharedNamespace_ownerKind_ownerId_idx" ON "PluginSharedNamespace"("ownerKind", "ownerId");

CREATE TABLE "PluginSharedValue" (
  "id" TEXT NOT NULL,
  "namespaceId" TEXT NOT NULL,
  "namespaceGeneration" INTEGER NOT NULL,
  "key" TEXT NOT NULL,
  "valueJson" JSONB NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "valueBytes" INTEGER NOT NULL,
  "revision" BIGINT NOT NULL,
  "createdByUserId" TEXT,
  "createdByPackageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PluginSharedValue_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PluginSharedValue_namespaceId_key_key" ON "PluginSharedValue"("namespaceId", "key");
CREATE INDEX "PluginSharedValue_namespaceId_revision_idx" ON "PluginSharedValue"("namespaceId", "revision");
CREATE INDEX "PluginSharedValue_namespaceId_namespaceGeneration_idx" ON "PluginSharedValue"("namespaceId", "namespaceGeneration");

CREATE TABLE "PluginSharedValueArtifact" (
  "id" TEXT NOT NULL,
  "namespaceId" TEXT NOT NULL,
  "namespaceGeneration" INTEGER NOT NULL,
  "key" TEXT NOT NULL,
  "valueRevision" BIGINT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "jsonPointer" TEXT NOT NULL,
  "executionKind" "ActionInvocationKind" NOT NULL DEFAULT 'STANDARD',
  CONSTRAINT "PluginSharedValueArtifact_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PluginSharedValueArtifact_scope_key" ON "PluginSharedValueArtifact"("namespaceId", "namespaceGeneration", "key", "valueRevision", "artifactId", "jsonPointer");
CREATE INDEX "PluginSharedValueArtifact_artifactId_executionKind_idx" ON "PluginSharedValueArtifact"("artifactId", "executionKind");
CREATE INDEX "PluginSharedValueArtifact_value_scope_idx" ON "PluginSharedValueArtifact"("namespaceId", "namespaceGeneration", "key", "valueRevision");

CREATE TABLE "SharedStateOutbox" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "namespaceId" TEXT NOT NULL,
  "namespaceGeneration" INTEGER NOT NULL,
  "cursor" BIGINT NOT NULL,
  "key" TEXT NOT NULL,
  "revision" BIGINT NOT NULL,
  "schemaVersion" INTEGER,
  "eventKind" "SharedChangeEventKind" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "SharedStateOutbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SharedStateOutbox_namespaceId_cursor_key" ON "SharedStateOutbox"("namespaceId", "cursor");
CREATE INDEX "SharedStateOutbox_teamId_createdAt_idx" ON "SharedStateOutbox"("teamId", "createdAt");
CREATE INDEX "SharedStateOutbox_publishedAt_createdAt_idx" ON "SharedStateOutbox"("publishedAt", "createdAt");

ALTER TABLE "PluginSharedNamespace" ADD CONSTRAINT "PluginSharedNamespace_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginSharedValue" ADD CONSTRAINT "PluginSharedValue_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES "PluginSharedNamespace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginSharedValueArtifact" ADD CONSTRAINT "PluginSharedValueArtifact_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES "PluginSharedNamespace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginSharedValueArtifact" ADD CONSTRAINT "PluginSharedValueArtifact_value_fkey" FOREIGN KEY ("namespaceId", "key") REFERENCES "PluginSharedValue"("namespaceId", "key") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginSharedValueArtifact" ADD CONSTRAINT "PluginSharedValueArtifact_artifact_fkey" FOREIGN KEY ("artifactId", "executionKind") REFERENCES "RuntimeArtifact"("id", "executionKind") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "SharedStateOutbox" ADD CONSTRAINT "SharedStateOutbox_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SharedStateOutbox" ADD CONSTRAINT "SharedStateOutbox_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES "PluginSharedNamespace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
