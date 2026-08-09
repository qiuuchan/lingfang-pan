-- 为 PluginRelease 增加灵坊适配检验改造流水线的产出字段。
-- adaptation_status: 最终适配状态（NOT_RUN / ADAPTED_PASSED / ADAPTED_FAILED / NEEDS_HUMAN）
-- run_evidence: 客户端附带的 AdaptationReport JSON（含运行时确证证据），可为空

ALTER TABLE "plugin_releases" ADD COLUMN "adaptation_status" TEXT NOT NULL DEFAULT 'NOT_RUN';
ALTER TABLE "plugin_releases" ADD COLUMN "run_evidence" TEXT;
