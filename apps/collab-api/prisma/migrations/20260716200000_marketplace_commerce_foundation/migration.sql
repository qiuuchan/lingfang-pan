CREATE TYPE "MarketplaceSettlementVersion" AS ENUM ('LEGACY_V1', 'SETTLEMENT_V2');
CREATE TYPE "MarketplaceOrderStatus" AS ENUM ('PENDING_SETTLEMENT', 'REFUND_REQUESTED', 'SETTLED', 'REFUNDED');
CREATE TYPE "MarketplaceEntitlementStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "MarketplaceCommerceWriterMode" AS ENUM ('LEGACY', 'DRAINING', 'SETTLEMENT_V2', 'PAUSED');
CREATE TYPE "MarketplacePlatformAccountKind" AS ENUM ('MARKETPLACE_CLEARING', 'MARKETPLACE_REVENUE');
CREATE TYPE "MarketplaceLedgerEntryKind" AS ENUM ('BUYER_PURCHASE_DEBIT', 'PLATFORM_PURCHASE_CLEARING_CREDIT', 'BUYER_REFUND_CREDIT', 'PLATFORM_REFUND_CLEARING_DEBIT', 'PLATFORM_SETTLEMENT_CLEARING_DEBIT', 'SELLER_SETTLEMENT_CREDIT', 'PLATFORM_SETTLEMENT_CREDIT');
CREATE TYPE "MarketplaceRefundRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "MarketplaceCampaignStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELED');
CREATE TYPE "MarketplaceAttributionKind" AS ENUM ('ORGANIC', 'CAMPAIGN');
CREATE TYPE "MarketplacePurchaseResultKind" AS ENUM ('ENTITLED_EXISTING', 'ORDER_CREATED');

ALTER TABLE "MarketplaceListing" ADD COLUMN "priceRevision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "PluginEntitlement"
  ADD COLUMN "status" "MarketplaceEntitlementStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "revokedByPurchaseId" TEXT,
  ADD COLUMN "revokedReason" TEXT NOT NULL DEFAULT '';

ALTER TABLE "Purchase"
  ADD COLUMN "releaseId" TEXT,
  ADD COLUMN "sellerTeamId" TEXT,
  ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'CNY',
  ADD COLUMN "listPriceCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "discountAmountCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "platformFeeBps" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "platformAmountCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "sellerAmountCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "settlementVersion" "MarketplaceSettlementVersion" NOT NULL DEFAULT 'LEGACY_V1',
  ADD COLUMN "priceRevision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "priceVersion" TEXT NOT NULL DEFAULT 'legacy-v1',
  ADD COLUMN "discountId" TEXT,
  ADD COLUMN "discountRevision" INTEGER,
  ADD COLUMN "campaignId" TEXT,
  ADD COLUMN "attributionKind" "MarketplaceAttributionKind" NOT NULL DEFAULT 'ORGANIC',
  ADD COLUMN "status" "MarketplaceOrderStatus" NOT NULL DEFAULT 'SETTLED',
  ADD COLUMN "settleAt" TIMESTAMP(3),
  ADD COLUMN "refundableUntil" TIMESTAMP(3),
  ADD COLUMN "settledAt" TIMESTAMP(3),
  ADD COLUMN "refundedAt" TIMESTAMP(3),
  ADD COLUMN "refundedByUserId" TEXT,
  ADD COLUMN "refundReason" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "idempotencyKey" TEXT;

UPDATE "Purchase"
SET "listPriceCents" = "priceCents",
    "sellerAmountCents" = "priceCents",
    "settledAt" = "createdAt";

UPDATE "PluginEntitlement"
SET "activatedAt" = "createdAt";

ALTER TABLE "BalanceLedger"
  ALTER COLUMN "teamId" DROP NOT NULL,
  ADD COLUMN "platformAccountId" TEXT,
  ADD COLUMN "purchaseId" TEXT,
  ADD COLUMN "marketplaceEntryKind" "MarketplaceLedgerEntryKind";

CREATE TABLE "MarketplaceCommerceState" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "writerMode" "MarketplaceCommerceWriterMode" NOT NULL DEFAULT 'LEGACY',
  "writerGeneration" INTEGER NOT NULL DEFAULT 0,
  "settlementV2ActivatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketplaceCommerceState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketplacePlatformAccount" (
  "id" TEXT NOT NULL,
  "kind" "MarketplacePlatformAccountKind" NOT NULL,
  "currencyCode" TEXT NOT NULL DEFAULT 'CNY',
  "balanceCents" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketplacePlatformAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketplacePurchaseIdempotency" (
  "id" TEXT NOT NULL,
  "buyerTeamId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "requestDigest" TEXT NOT NULL,
  "resultKind" "MarketplacePurchaseResultKind" NOT NULL,
  "purchaseId" TEXT,
  "entitlementId" TEXT NOT NULL,
  "responseJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketplacePurchaseIdempotency_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketplaceRefundRequest" (
  "id" TEXT NOT NULL,
  "purchaseId" TEXT NOT NULL,
  "requesterUserId" TEXT NOT NULL,
  "buyerTeamId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" "MarketplaceRefundRequestStatus" NOT NULL DEFAULT 'PENDING',
  "reviewedByUserId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewReason" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "MarketplaceRefundRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketplaceDiscount" (
  "id" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "priceCents" INTEGER NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "canceledAt" TIMESTAMP(3),
  "canceledByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketplaceDiscount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MarketplaceDiscount_price_window_check" CHECK ("priceCents" >= 1 AND "startsAt" < "endsAt")
);

CREATE TABLE "MarketplaceCampaign" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "status" "MarketplaceCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "createdByUserId" TEXT NOT NULL,
  "publishedByUserId" TEXT,
  "publishedAt" TIMESTAMP(3),
  "canceledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketplaceCampaign_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MarketplaceCampaign_window_check" CHECK ("startsAt" < "endsAt")
);

CREATE TABLE "MarketplaceCampaignItem" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "rank" INTEGER NOT NULL,
  CONSTRAINT "MarketplaceCampaignItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MarketplaceCampaignItem_rank_check" CHECK ("rank" >= 0)
);

INSERT INTO "MarketplaceCommerceState" ("id", "writerMode", "writerGeneration", "createdAt", "updatedAt")
VALUES ('singleton', 'LEGACY', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "MarketplacePlatformAccount" ("id", "kind", "currencyCode", "balanceCents", "createdAt", "updatedAt") VALUES
  ('marketplace-clearing', 'MARKETPLACE_CLEARING', 'CNY', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('marketplace-revenue', 'MARKETPLACE_REVENUE', 'CNY', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

CREATE UNIQUE INDEX "MarketplacePlatformAccount_kind_key" ON "MarketplacePlatformAccount"("kind");
CREATE UNIQUE INDEX "MarketplacePurchaseIdempotency_buyerTeamId_key_key" ON "MarketplacePurchaseIdempotency"("buyerTeamId", "key");
CREATE INDEX "MarketplacePurchaseIdempotency_packageId_createdAt_idx" ON "MarketplacePurchaseIdempotency"("packageId", "createdAt");
CREATE INDEX "MarketplacePurchaseIdempotency_purchaseId_idx" ON "MarketplacePurchaseIdempotency"("purchaseId");
CREATE UNIQUE INDEX "MarketplaceRefundRequest_purchaseId_key" ON "MarketplaceRefundRequest"("purchaseId");
CREATE INDEX "MarketplaceRefundRequest_buyerTeamId_status_requestedAt_idx" ON "MarketplaceRefundRequest"("buyerTeamId", "status", "requestedAt");
CREATE INDEX "MarketplaceRefundRequest_status_requestedAt_idx" ON "MarketplaceRefundRequest"("status", "requestedAt");
CREATE INDEX "MarketplaceDiscount_packageId_startsAt_endsAt_idx" ON "MarketplaceDiscount"("packageId", "startsAt", "endsAt");
CREATE INDEX "MarketplaceDiscount_packageId_canceledAt_idx" ON "MarketplaceDiscount"("packageId", "canceledAt");
CREATE UNIQUE INDEX "MarketplaceCampaign_slug_key" ON "MarketplaceCampaign"("slug");
CREATE INDEX "MarketplaceCampaign_status_startsAt_endsAt_idx" ON "MarketplaceCampaign"("status", "startsAt", "endsAt");
CREATE UNIQUE INDEX "MarketplaceCampaignItem_campaignId_packageId_key" ON "MarketplaceCampaignItem"("campaignId", "packageId");
CREATE UNIQUE INDEX "MarketplaceCampaignItem_campaignId_rank_key" ON "MarketplaceCampaignItem"("campaignId", "rank");
CREATE INDEX "MarketplaceCampaignItem_packageId_idx" ON "MarketplaceCampaignItem"("packageId");
CREATE INDEX "PluginEntitlement_teamId_packageId_status_idx" ON "PluginEntitlement"("teamId", "packageId", "status");
CREATE INDEX "PluginEntitlement_revokedByPurchaseId_idx" ON "PluginEntitlement"("revokedByPurchaseId");
CREATE INDEX "Purchase_releaseId_idx" ON "Purchase"("releaseId");
CREATE INDEX "Purchase_sellerTeamId_status_createdAt_idx" ON "Purchase"("sellerTeamId", "status", "createdAt");
CREATE INDEX "Purchase_status_settleAt_idx" ON "Purchase"("status", "settleAt");
CREATE INDEX "Purchase_discountId_idx" ON "Purchase"("discountId");
CREATE INDEX "Purchase_campaignId_idx" ON "Purchase"("campaignId");
CREATE INDEX "BalanceLedger_platformAccountId_createdAt_idx" ON "BalanceLedger"("platformAccountId", "createdAt");
CREATE INDEX "BalanceLedger_purchaseId_createdAt_idx" ON "BalanceLedger"("purchaseId", "createdAt");
CREATE UNIQUE INDEX "BalanceLedger_purchaseId_marketplaceEntryKind_key" ON "BalanceLedger"("purchaseId", "marketplaceEntryKind");

ALTER TABLE "BalanceLedger" ADD CONSTRAINT "BalanceLedger_owner_xor_check" CHECK (num_nonnulls("teamId", "platformAccountId") = 1);
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_marketplace_amounts_check" CHECK (
  "listPriceCents" >= 0 AND "discountAmountCents" >= 0 AND "priceCents" >= 0
  AND "platformFeeBps" BETWEEN 0 AND 10000
  AND "platformAmountCents" >= 0 AND "sellerAmountCents" >= 0
  AND "listPriceCents" - "discountAmountCents" = "priceCents"
  AND "platformAmountCents" + "sellerAmountCents" = "priceCents"
);
ALTER TABLE "MarketplacePlatformAccount" ADD CONSTRAINT "MarketplacePlatformAccount_currency_check" CHECK ("currencyCode" = 'CNY' AND "balanceCents" >= 0);

ALTER TABLE "PluginEntitlement" ADD CONSTRAINT "PluginEntitlement_revokedByPurchaseId_fkey" FOREIGN KEY ("revokedByPurchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "PluginRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_buyerTeamId_fkey" FOREIGN KEY ("buyerTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_sellerTeamId_fkey" FOREIGN KEY ("sellerTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_refundedByUserId_fkey" FOREIGN KEY ("refundedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_discountId_fkey" FOREIGN KEY ("discountId") REFERENCES "MarketplaceDiscount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketplaceCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BalanceLedger" ADD CONSTRAINT "BalanceLedger_platformAccountId_fkey" FOREIGN KEY ("platformAccountId") REFERENCES "MarketplacePlatformAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BalanceLedger" ADD CONSTRAINT "BalanceLedger_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplacePurchaseIdempotency" ADD CONSTRAINT "MarketplacePurchaseIdempotency_buyerTeamId_fkey" FOREIGN KEY ("buyerTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplacePurchaseIdempotency" ADD CONSTRAINT "MarketplacePurchaseIdempotency_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplacePurchaseIdempotency" ADD CONSTRAINT "MarketplacePurchaseIdempotency_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "PluginEntitlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplaceRefundRequest" ADD CONSTRAINT "MarketplaceRefundRequest_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplaceRefundRequest" ADD CONSTRAINT "MarketplaceRefundRequest_requesterUserId_fkey" FOREIGN KEY ("requesterUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplaceRefundRequest" ADD CONSTRAINT "MarketplaceRefundRequest_buyerTeamId_fkey" FOREIGN KEY ("buyerTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplaceRefundRequest" ADD CONSTRAINT "MarketplaceRefundRequest_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketplaceDiscount" ADD CONSTRAINT "MarketplaceDiscount_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "PluginPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplaceDiscount" ADD CONSTRAINT "MarketplaceDiscount_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplaceDiscount" ADD CONSTRAINT "MarketplaceDiscount_canceledByUserId_fkey" FOREIGN KEY ("canceledByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketplaceCampaign" ADD CONSTRAINT "MarketplaceCampaign_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplaceCampaign" ADD CONSTRAINT "MarketplaceCampaign_publishedByUserId_fkey" FOREIGN KEY ("publishedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketplaceCampaignItem" ADD CONSTRAINT "MarketplaceCampaignItem_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketplaceCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketplaceCampaignItem" ADD CONSTRAINT "MarketplaceCampaignItem_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "PluginPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
