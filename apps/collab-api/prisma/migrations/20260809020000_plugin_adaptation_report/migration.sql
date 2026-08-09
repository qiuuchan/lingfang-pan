-- 适配报告暂存位：HTTP 头装不下含中文/大体积的 AdaptationReport，
-- 改为先 POST 换取纯 ASCII 的 reportId，发布时只带 id。

CREATE TABLE "PluginAdaptationReport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "report" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PluginAdaptationReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PluginAdaptationReport_userId_teamId_expiresAt_idx" ON "PluginAdaptationReport"("userId", "teamId", "expiresAt");

CREATE INDEX "PluginAdaptationReport_expiresAt_idx" ON "PluginAdaptationReport"("expiresAt");

ALTER TABLE "PluginAdaptationReport" ADD CONSTRAINT "PluginAdaptationReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PluginAdaptationReport" ADD CONSTRAINT "PluginAdaptationReport_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
