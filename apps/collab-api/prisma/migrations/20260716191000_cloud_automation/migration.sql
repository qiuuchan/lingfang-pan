CREATE TYPE "CloudDeploymentEnvironment" AS ENUM ('PREVIEW', 'PRODUCTION');
CREATE TYPE "CloudDeploymentStatus" AS ENUM ('DRAFT', 'VERIFYING', 'READY', 'DISABLED', 'RETIRED');
CREATE TYPE "AutomationScheduleKind" AS ENUM ('ONCE', 'DAILY', 'WEEKLY');
CREATE TYPE "AutomationScheduleStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'MISSED', 'DELETED');
CREATE TYPE "AutomationScheduleSyncState" AS ENUM ('PENDING', 'SYNCED', 'ERROR');
CREATE TYPE "AutomationOutboxKind" AS ENUM ('UPSERT_SCHEDULE', 'REMOVE_SCHEDULE', 'ENQUEUE_RUN', 'CANCEL_RUN');
CREATE TYPE "AutomationOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');
CREATE TYPE "CloudUsageSourceKind" AS ENUM ('ACTION_INVOCATION', 'WORKFLOW_ATTEMPT');
CREATE TYPE "CloudUsageEventKind" AS ENUM ('EXECUTION');
CREATE TYPE "CloudUsageOutcome" AS ENUM ('SUCCEEDED', 'FAILED', 'CANCELED', 'TIMED_OUT', 'RESULT_UNKNOWN');

ALTER TABLE "ActionInvocation"
  ADD COLUMN "cloudDeploymentId" TEXT,
  ADD COLUMN "cloudRoutingGeneration" INTEGER,
  ADD COLUMN "cloudEnvironment" "CloudDeploymentEnvironment";

ALTER TABLE "WorkflowRun"
  ADD COLUMN "scheduleId" TEXT,
  ADD COLUMN "scheduleGeneration" INTEGER,
  ADD COLUMN "scheduledFor" TIMESTAMP(3),
  ADD COLUMN "occurrenceKey" TEXT;

ALTER TABLE "WorkflowStepAttempt"
  ADD COLUMN "transportJobId" TEXT,
  ADD COLUMN "deliveryState" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN "transportRequestSha256" TEXT,
  ADD COLUMN "transportResponseSha256" TEXT,
  ADD COLUMN "endpointHttpStatus" INTEGER,
  ADD COLUMN "requestBytes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "responseBytes" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "CloudActionDeployment" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "releaseId" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "actionId" TEXT NOT NULL,
  "actionContractVersion" TEXT NOT NULL,
  "actionSurfaceSha256" TEXT NOT NULL,
  "environment" "CloudDeploymentEnvironment" NOT NULL,
  "deploymentKey" TEXT NOT NULL,
  "supersedesDeploymentId" TEXT,
  "endpointUrl" TEXT NOT NULL,
  "secretCiphertext" TEXT NOT NULL,
  "secretVersion" INTEGER NOT NULL DEFAULT 1,
  "status" "CloudDeploymentStatus" NOT NULL DEFAULT 'DRAFT',
  "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
  "maxConcurrency" INTEGER NOT NULL DEFAULT 4,
  "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 60,
  "responseLimitBytes" INTEGER NOT NULL DEFAULT 1048576,
  "lastHealthAt" TIMESTAMP(3),
  "lastHealthOk" BOOLEAN,
  "lastHealthErrorCode" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CloudActionDeployment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CloudActionRouting" (
  "id" TEXT NOT NULL,
  "releaseId" TEXT NOT NULL,
  "actionId" TEXT NOT NULL,
  "actionContractVersion" TEXT NOT NULL,
  "actionSurfaceSha256" TEXT NOT NULL,
  "environment" "CloudDeploymentEnvironment" NOT NULL,
  "stableDeploymentId" TEXT NOT NULL,
  "candidateDeploymentId" TEXT,
  "candidatePercent" INTEGER NOT NULL DEFAULT 0,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CloudActionRouting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkflowRunCloudBinding" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "nodePath" TEXT NOT NULL,
  "deploymentId" TEXT NOT NULL,
  "routingGeneration" INTEGER NOT NULL,
  "environment" "CloudDeploymentEnvironment" NOT NULL,
  "policyDecisionId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkflowRunCloudBinding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutomationSchedule" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "workflowReleaseId" TEXT NOT NULL,
  "workflowReleaseSha256" TEXT NOT NULL,
  "kind" "AutomationScheduleKind" NOT NULL,
  "timeZone" TEXT,
  "runAt" TIMESTAMP(3),
  "localTime" TEXT,
  "dayOfWeek" INTEGER,
  "inputJson" JSONB NOT NULL,
  "inputSchemaSha256" TEXT NOT NULL,
  "status" "AutomationScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
  "generation" INTEGER NOT NULL DEFAULT 1,
  "schedulerKey" TEXT NOT NULL,
  "nextRunAt" TIMESTAMP(3),
  "lastScheduledFor" TIMESTAMP(3),
  "lastRunId" TEXT,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "syncState" "AutomationScheduleSyncState" NOT NULL DEFAULT 'PENDING',
  "syncErrorCode" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutomationSchedule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutomationOutbox" (
  "id" TEXT NOT NULL,
  "kind" "AutomationOutboxKind" NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "AutomationOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lockedBy" TEXT,
  "lockedUntil" TIMESTAMP(3),
  "lastErrorCode" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutomationOutbox_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CloudUsageEvent" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "sourceKind" "CloudUsageSourceKind" NOT NULL,
  "sourceId" TEXT NOT NULL,
  "eventKind" "CloudUsageEventKind" NOT NULL DEFAULT 'EXECUTION',
  "packageId" TEXT NOT NULL,
  "releaseId" TEXT NOT NULL,
  "releaseSha256" TEXT NOT NULL,
  "actionId" TEXT NOT NULL,
  "actionContractVersion" TEXT NOT NULL,
  "actionSurfaceSha256" TEXT NOT NULL,
  "deploymentId" TEXT NOT NULL,
  "executionScope" "WorkflowExecutionScope" NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "requestBytes" INTEGER NOT NULL DEFAULT 0,
  "responseBytes" INTEGER NOT NULL DEFAULT 0,
  "artifactInputBytes" INTEGER NOT NULL DEFAULT 0,
  "artifactOutputBytes" INTEGER NOT NULL DEFAULT 0,
  "outcome" "CloudUsageOutcome" NOT NULL,
  "pricingDimensions" JSONB NOT NULL DEFAULT '{}',
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CloudUsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ActionInvocation_cloudDeploymentId_status_idx" ON "ActionInvocation"("cloudDeploymentId", "status");
CREATE UNIQUE INDEX "WorkflowRun_scheduleId_scheduleGeneration_occurrenceKey_key" ON "WorkflowRun"("scheduleId", "scheduleGeneration", "occurrenceKey");
CREATE INDEX "WorkflowRun_scheduleId_scheduledFor_idx" ON "WorkflowRun"("scheduleId", "scheduledFor");
CREATE INDEX "WorkflowStepAttempt_transportJobId_idx" ON "WorkflowStepAttempt"("transportJobId");

CREATE UNIQUE INDEX "CloudActionDeployment_releaseId_actionId_actionContractVers_key" ON "CloudActionDeployment"("releaseId", "actionId", "actionContractVersion", "actionSurfaceSha256", "environment", "deploymentKey");
CREATE INDEX "CloudActionDeployment_teamId_status_createdAt_idx" ON "CloudActionDeployment"("teamId", "status", "createdAt");
CREATE INDEX "CloudActionDeployment_packageId_releaseId_sha256_idx" ON "CloudActionDeployment"("packageId", "releaseId", "sha256");
CREATE INDEX "CloudActionDeployment_supersedesDeploymentId_idx" ON "CloudActionDeployment"("supersedesDeploymentId");

CREATE UNIQUE INDEX "CloudActionRouting_releaseId_actionId_actionContractVersion_key" ON "CloudActionRouting"("releaseId", "actionId", "actionContractVersion", "actionSurfaceSha256", "environment");
CREATE INDEX "CloudActionRouting_stableDeploymentId_idx" ON "CloudActionRouting"("stableDeploymentId");
CREATE INDEX "CloudActionRouting_candidateDeploymentId_idx" ON "CloudActionRouting"("candidateDeploymentId");

CREATE UNIQUE INDEX "WorkflowRunCloudBinding_runId_nodePath_key" ON "WorkflowRunCloudBinding"("runId", "nodePath");
CREATE INDEX "WorkflowRunCloudBinding_deploymentId_idx" ON "WorkflowRunCloudBinding"("deploymentId");

CREATE UNIQUE INDEX "AutomationSchedule_teamId_schedulerKey_key" ON "AutomationSchedule"("teamId", "schedulerKey");
CREATE INDEX "AutomationSchedule_teamId_status_nextRunAt_idx" ON "AutomationSchedule"("teamId", "status", "nextRunAt");
CREATE INDEX "AutomationSchedule_workflowReleaseId_status_idx" ON "AutomationSchedule"("workflowReleaseId", "status");
CREATE INDEX "AutomationSchedule_createdByUserId_status_idx" ON "AutomationSchedule"("createdByUserId", "status");

CREATE UNIQUE INDEX "AutomationOutbox_kind_aggregateId_generation_key" ON "AutomationOutbox"("kind", "aggregateId", "generation");
CREATE INDEX "AutomationOutbox_status_availableAt_idx" ON "AutomationOutbox"("status", "availableAt");
CREATE INDEX "AutomationOutbox_lockedUntil_idx" ON "AutomationOutbox"("lockedUntil");

CREATE UNIQUE INDEX "CloudUsageEvent_sourceKind_sourceId_eventKind_key" ON "CloudUsageEvent"("sourceKind", "sourceId", "eventKind");
CREATE INDEX "CloudUsageEvent_teamId_occurredAt_idx" ON "CloudUsageEvent"("teamId", "occurredAt");
CREATE INDEX "CloudUsageEvent_deploymentId_occurredAt_idx" ON "CloudUsageEvent"("deploymentId", "occurredAt");
CREATE INDEX "CloudUsageEvent_releaseId_actionId_occurredAt_idx" ON "CloudUsageEvent"("releaseId", "actionId", "occurredAt");

ALTER TABLE "ActionInvocation" ADD CONSTRAINT "ActionInvocation_cloudDeploymentId_fkey" FOREIGN KEY ("cloudDeploymentId") REFERENCES "CloudActionDeployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "AutomationSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CloudActionDeployment" ADD CONSTRAINT "CloudActionDeployment_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CloudActionDeployment" ADD CONSTRAINT "CloudActionDeployment_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "PluginRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CloudActionDeployment" ADD CONSTRAINT "CloudActionDeployment_supersedesDeploymentId_fkey" FOREIGN KEY ("supersedesDeploymentId") REFERENCES "CloudActionDeployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CloudActionRouting" ADD CONSTRAINT "CloudActionRouting_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "PluginRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CloudActionRouting" ADD CONSTRAINT "CloudActionRouting_stableDeploymentId_fkey" FOREIGN KEY ("stableDeploymentId") REFERENCES "CloudActionDeployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CloudActionRouting" ADD CONSTRAINT "CloudActionRouting_candidateDeploymentId_fkey" FOREIGN KEY ("candidateDeploymentId") REFERENCES "CloudActionDeployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WorkflowRunCloudBinding" ADD CONSTRAINT "WorkflowRunCloudBinding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowRunCloudBinding" ADD CONSTRAINT "WorkflowRunCloudBinding_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "CloudActionDeployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AutomationSchedule" ADD CONSTRAINT "AutomationSchedule_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationSchedule" ADD CONSTRAINT "AutomationSchedule_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AutomationSchedule" ADD CONSTRAINT "AutomationSchedule_workflowReleaseId_fkey" FOREIGN KEY ("workflowReleaseId") REFERENCES "WorkflowRelease"("pluginReleaseId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CloudUsageEvent" ADD CONSTRAINT "CloudUsageEvent_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CloudUsageEvent" ADD CONSTRAINT "CloudUsageEvent_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "CloudActionDeployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
