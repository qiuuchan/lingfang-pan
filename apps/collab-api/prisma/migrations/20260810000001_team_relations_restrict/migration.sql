-- P1-3：将财务/审计四表对 Team 的外键由 ON DELETE CASCADE 改为 ON DELETE RESTRICT。
-- 防止误删（或未来引入物理删除路径时）连带物理抹掉余额流水、云用量事件、灵石流水、
-- LLM 调用日志等不可再生的财务/审计记录——这些表是计费对账与合规审计的底层事实。
-- 应用层当前无物理删 Team 的代码路径（adminDeleteTeam 仅置 SUSPENDED 软删），
-- 故改为 RESTRICT 不会破坏既有业务，只会在「删有账目的团队」时显式报错而非静默级联。
-- 约束名沿用 Prisma 默认名（<Table>_teamId_fkey），保证与 schema.prisma 重新生成时一致。

ALTER TABLE "BalanceLedger" DROP CONSTRAINT "BalanceLedger_teamId_fkey";
ALTER TABLE "BalanceLedger" ADD CONSTRAINT "BalanceLedger_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CloudUsageEvent" DROP CONSTRAINT "CloudUsageEvent_teamId_fkey";
ALTER TABLE "CloudUsageEvent" ADD CONSTRAINT "CloudUsageEvent_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CreditLedger" DROP CONSTRAINT "CreditLedger_teamId_fkey";
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LlmCallLog" DROP CONSTRAINT "LlmCallLog_teamId_fkey";
ALTER TABLE "LlmCallLog" ADD CONSTRAINT "LlmCallLog_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
