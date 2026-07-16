ALTER TABLE "Purchase" ADD COLUMN "campaignItemId" TEXT;
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_campaignItemId_fkey" FOREIGN KEY ("campaignItemId") REFERENCES "MarketplaceCampaignItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Purchase_campaignItemId_createdAt_idx" ON "Purchase"("campaignItemId", "createdAt");
