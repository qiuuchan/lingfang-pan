CREATE TYPE "WorkflowExecutionScope" AS ENUM ('PRODUCTION', 'PREVIEW');
CREATE TYPE "WorkflowExecutionTarget" AS ENUM ('DESKTOP', 'CLOUD');
CREATE TYPE "WorkflowRunStatus" AS ENUM ('PENDING', 'RUNNING', 'FAILING', 'SUCCEEDED', 'FAILED', 'CANCELING', 'CANCELED');
CREATE TYPE "WorkflowStepStatus" AS ENUM ('PENDING', 'READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELED');

CREATE TABLE "WorkflowRelease" (
  "pluginReleaseId" TEXT NOT NULL, "definitionVersion" TEXT NOT NULL, "definitionSha256" TEXT NOT NULL,
  "definitionJson" JSONB NOT NULL, "inputSchema" JSONB NOT NULL, "outputSchema" JSONB NOT NULL,
  "cloudEligible" BOOLEAN NOT NULL DEFAULT false, "expandedNodeCount" INTEGER NOT NULL, "maxParallelism" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "WorkflowRelease_pkey" PRIMARY KEY ("pluginReleaseId")
);
CREATE TABLE "WorkflowReleaseNode" (
  "id" TEXT NOT NULL, "workflowReleaseId" TEXT NOT NULL, "nodeId" TEXT NOT NULL, "declaredVersionRange" TEXT NOT NULL,
  "packageId" TEXT NOT NULL, "releaseId" TEXT NOT NULL, "sha256" TEXT NOT NULL, "actionId" TEXT NOT NULL,
  "actionContractVersion" TEXT NOT NULL, "actionSurfaceSha256" TEXT NOT NULL, "executionSemantics" TEXT NOT NULL,
  "cloudCapable" BOOLEAN NOT NULL DEFAULT false, "retryLimit" INTEGER NOT NULL DEFAULT 0,
  "dependsOn" JSONB NOT NULL DEFAULT '[]', "inputBindings" JSONB NOT NULL DEFAULT '[]', CONSTRAINT "WorkflowReleaseNode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkflowReleaseNode_workflowReleaseId_nodeId_key" ON "WorkflowReleaseNode"("workflowReleaseId", "nodeId");
CREATE INDEX "WorkflowReleaseNode_releaseId_actionId_idx" ON "WorkflowReleaseNode"("releaseId", "actionId");

CREATE TABLE "WorkflowRun" (
  "id" TEXT NOT NULL, "teamId" TEXT NOT NULL, "principalUserId" TEXT, "workflowReleaseId" TEXT NOT NULL,
  "executionScope" "WorkflowExecutionScope" NOT NULL, "executionTarget" "WorkflowExecutionTarget" NOT NULL,
  "status" "WorkflowRunStatus" NOT NULL DEFAULT 'PENDING', "requestScopeSha256" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL,
  "requestDigest" TEXT NOT NULL, "inputDigest" TEXT NOT NULL, "rootLogicalExecutionId" TEXT NOT NULL,
  "planSha256" TEXT NOT NULL, "frozenPlan" JSONB NOT NULL, "input" JSONB NOT NULL, "output" JSONB,
  "policyRevision" INTEGER NOT NULL, "authorizationDecision" JSONB NOT NULL, "rootRunId" TEXT, "parentStepAttemptId" TEXT,
  "triggerKind" TEXT NOT NULL, "deadlineAt" TIMESTAMP(3) NOT NULL, "resultRetainUntil" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "errorCode" TEXT NOT NULL DEFAULT '', "errorMessage" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkflowRun_requestScopeSha256_idempotencyKey_key" ON "WorkflowRun"("requestScopeSha256", "idempotencyKey");
CREATE INDEX "WorkflowRun_teamId_status_createdAt_idx" ON "WorkflowRun"("teamId", "status", "createdAt");
CREATE INDEX "WorkflowRun_workflowReleaseId_createdAt_idx" ON "WorkflowRun"("workflowReleaseId", "createdAt");
CREATE INDEX "WorkflowRun_rootRunId_createdAt_idx" ON "WorkflowRun"("rootRunId", "createdAt");

CREATE TABLE "WorkflowStepAttempt" (
  "id" TEXT NOT NULL, "runId" TEXT NOT NULL, "nodeId" TEXT NOT NULL, "fullNodePath" TEXT NOT NULL, "attempt" INTEGER NOT NULL,
  "status" "WorkflowStepStatus" NOT NULL DEFAULT 'PENDING', "actionInvocationId" TEXT, "requestKey" TEXT NOT NULL, "effectKey" TEXT,
  "input" JSONB, "inputSha256" TEXT, "output" JSONB, "outputSha256" TEXT,
  "packageId" TEXT NOT NULL, "releaseId" TEXT NOT NULL, "releaseSha256" TEXT NOT NULL, "actionId" TEXT NOT NULL,
  "actionContractVersion" TEXT NOT NULL, "actionSurfaceSha256" TEXT NOT NULL, "executionSemantics" TEXT NOT NULL, "retryLimit" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "errorCode" TEXT NOT NULL DEFAULT '', "errorMessage" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "WorkflowStepAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkflowStepAttempt_actionInvocationId_key" ON "WorkflowStepAttempt"("actionInvocationId");
CREATE UNIQUE INDEX "WorkflowStepAttempt_runId_nodeId_attempt_key" ON "WorkflowStepAttempt"("runId", "nodeId", "attempt");
CREATE INDEX "WorkflowStepAttempt_runId_status_idx" ON "WorkflowStepAttempt"("runId", "status");

ALTER TABLE "WorkflowRelease" ADD CONSTRAINT "WorkflowRelease_pluginReleaseId_fkey" FOREIGN KEY ("pluginReleaseId") REFERENCES "PluginRelease"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowReleaseNode" ADD CONSTRAINT "WorkflowReleaseNode_workflowReleaseId_fkey" FOREIGN KEY ("workflowReleaseId") REFERENCES "WorkflowRelease"("pluginReleaseId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_principalUserId_fkey" FOREIGN KEY ("principalUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workflowReleaseId_fkey" FOREIGN KEY ("workflowReleaseId") REFERENCES "WorkflowRelease"("pluginReleaseId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkflowStepAttempt" ADD CONSTRAINT "WorkflowStepAttempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowStepAttempt" ADD CONSTRAINT "WorkflowStepAttempt_actionInvocationId_fkey" FOREIGN KEY ("actionInvocationId") REFERENCES "ActionInvocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
