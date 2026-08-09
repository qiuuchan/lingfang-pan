-- 为 PluginRelease 增加灵坊适配检验改造流水线的产出字段。
-- adaptationStatus: 最终适配状态（NOT_RUN / ADAPTED_PASSED / ADAPTED_FAILED / NEEDS_HUMAN）
-- runEvidence: 兑付暂存后落库的 AdaptationReport JSON（含运行时确证证据），可为空

ALTER TABLE "PluginRelease" ADD COLUMN "adaptationStatus" TEXT NOT NULL DEFAULT 'NOT_RUN';
ALTER TABLE "PluginRelease" ADD COLUMN "runEvidence" TEXT;
