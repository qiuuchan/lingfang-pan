CREATE TYPE "ActionInvocationKind" AS ENUM ('STANDARD', 'PREVIEW');
CREATE TYPE "ActionInvocationStatus" AS ENUM ('AUTHORIZED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'TIMED_OUT');
CREATE TYPE "RuntimeArtifactStatus" AS ENUM ('ACTIVE', 'DELETED');
CREATE TYPE "RuntimeArtifactGrantTarget" AS ENUM ('INVOCATION', 'LOGICAL_EFFECT', 'PRINCIPAL_IMPORT', 'WORKFLOW_RUN', 'SHARED_VALUE');

CREATE TABLE "ActionInvocation" (
  "id" TEXT NOT NULL, "teamId" TEXT NOT NULL, "principalUserId" TEXT, "kind" "ActionInvocationKind" NOT NULL,
  "status" "ActionInvocationStatus" NOT NULL DEFAULT 'AUTHORIZED', "packageId" TEXT NOT NULL, "releaseId" TEXT NOT NULL,
  "releaseSha256" TEXT NOT NULL, "actionId" TEXT NOT NULL, "actionContractVersion" TEXT NOT NULL, "actionSurfaceSha256" TEXT NOT NULL,
  "callerKind" TEXT NOT NULL, "callerId" TEXT NOT NULL, "requestId" TEXT NOT NULL, "requestScopeKey" TEXT NOT NULL,
  "requestIdempotencyKey" TEXT NOT NULL, "effectIdempotencyKey" TEXT, "rootInvocationId" TEXT, "parentInvocationId" TEXT,
  "policyRevision" INTEGER NOT NULL, "requiredOperations" JSONB NOT NULL DEFAULT '[]', "input" JSONB NOT NULL, "inputSha256" TEXT NOT NULL,
  "output" JSONB, "outputSha256" TEXT, "authorizationDecision" JSONB, "executionBinding" JSONB, "callChain" JSONB NOT NULL DEFAULT '[]',
  "deadlineAt" TIMESTAMP(3) NOT NULL, "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "errorCode" TEXT NOT NULL DEFAULT '',
  "errorMessage" TEXT NOT NULL DEFAULT '', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ActionInvocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ActionInvocation_requestScopeKey_key" ON "ActionInvocation"("requestScopeKey");
CREATE INDEX "ActionInvocation_teamId_status_createdAt_idx" ON "ActionInvocation"("teamId", "status", "createdAt");
CREATE INDEX "ActionInvocation_releaseId_actionId_createdAt_idx" ON "ActionInvocation"("releaseId", "actionId", "createdAt");
CREATE INDEX "ActionInvocation_rootInvocationId_createdAt_idx" ON "ActionInvocation"("rootInvocationId", "createdAt");
CREATE INDEX "ActionInvocation_parentInvocationId_idx" ON "ActionInvocation"("parentInvocationId");

CREATE TABLE "RuntimeArtifact" (
  "id" TEXT NOT NULL, "teamId" TEXT NOT NULL, "creatorInvocationId" TEXT, "executionKind" "ActionInvocationKind" NOT NULL,
  "objectKey" TEXT NOT NULL, "mediaType" TEXT NOT NULL, "sizeBytes" INTEGER NOT NULL, "sha256" TEXT NOT NULL,
  "status" "RuntimeArtifactStatus" NOT NULL DEFAULT 'ACTIVE', "retainUntil" TIMESTAMP(3) NOT NULL, "effectReplayUntil" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "RuntimeArtifact_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RuntimeArtifact_objectKey_key" ON "RuntimeArtifact"("objectKey");
CREATE UNIQUE INDEX "RuntimeArtifact_id_executionKind_key" ON "RuntimeArtifact"("id", "executionKind");
CREATE INDEX "RuntimeArtifact_teamId_status_retainUntil_idx" ON "RuntimeArtifact"("teamId", "status", "retainUntil");
CREATE INDEX "RuntimeArtifact_creatorInvocationId_idx" ON "RuntimeArtifact"("creatorInvocationId");

CREATE TABLE "RuntimeArtifactGrant" (
  "id" TEXT NOT NULL, "artifactId" TEXT NOT NULL, "executionKind" "ActionInvocationKind" NOT NULL,
  "targetKind" "RuntimeArtifactGrantTarget" NOT NULL, "targetId" TEXT NOT NULL, "scopeDigest" TEXT NOT NULL, "subjectKey" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RuntimeArtifactGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RuntimeArtifactGrant_artifactId_executionKind_subjectKey_key" ON "RuntimeArtifactGrant"("artifactId", "executionKind", "subjectKey");
CREATE INDEX "RuntimeArtifactGrant_targetKind_targetId_expiresAt_idx" ON "RuntimeArtifactGrant"("targetKind", "targetId", "expiresAt");

CREATE TABLE "RuntimeArtifactHold" (
  "id" TEXT NOT NULL, "artifactId" TEXT NOT NULL, "executionKind" "ActionInvocationKind" NOT NULL,
  "holderKind" TEXT NOT NULL, "holderId" TEXT NOT NULL, "purpose" TEXT NOT NULL, "scopeDigest" TEXT NOT NULL, "holderKey" TEXT NOT NULL,
  "retainUntil" TIMESTAMP(3) NOT NULL, "releasedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RuntimeArtifactHold_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RuntimeArtifactHold_artifactId_executionKind_holderKey_key" ON "RuntimeArtifactHold"("artifactId", "executionKind", "holderKey");
CREATE INDEX "RuntimeArtifactHold_holderKind_holderId_retainUntil_idx" ON "RuntimeArtifactHold"("holderKind", "holderId", "retainUntil");

ALTER TABLE "ActionInvocation" ADD CONSTRAINT "ActionInvocation_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActionInvocation" ADD CONSTRAINT "ActionInvocation_principalUserId_fkey" FOREIGN KEY ("principalUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActionInvocation" ADD CONSTRAINT "ActionInvocation_parentInvocationId_fkey" FOREIGN KEY ("parentInvocationId") REFERENCES "ActionInvocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RuntimeArtifact" ADD CONSTRAINT "RuntimeArtifact_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RuntimeArtifact" ADD CONSTRAINT "RuntimeArtifact_creatorInvocationId_fkey" FOREIGN KEY ("creatorInvocationId") REFERENCES "ActionInvocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RuntimeArtifactGrant" ADD CONSTRAINT "RuntimeArtifactGrant_artifactId_executionKind_fkey" FOREIGN KEY ("artifactId", "executionKind") REFERENCES "RuntimeArtifact"("id", "executionKind") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "RuntimeArtifactHold" ADD CONSTRAINT "RuntimeArtifactHold_artifactId_executionKind_fkey" FOREIGN KEY ("artifactId", "executionKind") REFERENCES "RuntimeArtifact"("id", "executionKind") ON DELETE CASCADE ON UPDATE RESTRICT;
