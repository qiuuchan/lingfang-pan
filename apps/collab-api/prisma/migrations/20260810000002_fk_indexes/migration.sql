-- P1-4：为 4 个高频查询外键补索引，缩小审计/财务类查询的扫描范围（对应 schema.prisma 新增的 @@index）。
--   ActionInvocation.principalUserId —— 按发起用户查其全部调用。
--   WorkflowRun.principalUserId      —— 按发起用户查其全部工作流运行。
--   CreditLedger.actorUserId         —— 按触发者查灵石流水（消费/调整对账）。
--   LlmCallLog.channelId             —— 按渠道聚合调用量与成本（LlmCallLog 为体量最大的表）。
-- 索引名沿用 Prisma 默认名（<Table>_<field>_idx），保证与 schema.prisma 重新生成时一致。

CREATE INDEX "ActionInvocation_principalUserId_idx" ON "ActionInvocation"("principalUserId");
CREATE INDEX "WorkflowRun_principalUserId_idx" ON "WorkflowRun"("principalUserId");
CREATE INDEX "CreditLedger_actorUserId_idx" ON "CreditLedger"("actorUserId");
CREATE INDEX "LlmCallLog_channelId_idx" ON "LlmCallLog"("channelId");
