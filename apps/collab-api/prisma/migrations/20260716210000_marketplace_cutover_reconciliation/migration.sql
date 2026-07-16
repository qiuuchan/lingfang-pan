-- Additive operational state for the settlement cutover and durable job status.
-- This migration intentionally does not write balances, orders, or ledger rows.
CREATE TYPE "MarketplaceSettlementJobRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

ALTER TABLE "MarketplaceCommerceState"
  ADD COLUMN "pausedAt" TIMESTAMP(3),
  ADD COLUMN "pauseReason" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "lastSettlementJobAt" TIMESTAMP(3),
  ADD COLUMN "lastSettlementJobStatus" "MarketplaceSettlementJobRunStatus",
  ADD COLUMN "lastSettlementJobScanned" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastSettlementJobSettled" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastSettlementJobSkipped" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastSettlementJobError" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "lastReconciliationAt" TIMESTAMP(3),
  ADD COLUMN "lastReconciliationStatus" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "lastReconciliationReport" JSONB;
