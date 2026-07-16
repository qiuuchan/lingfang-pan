DROP INDEX IF EXISTS "Purchase_packageId_buyerTeamId_key";
CREATE INDEX "Purchase_packageId_buyerTeamId_idx" ON "Purchase"("packageId", "buyerTeamId");
