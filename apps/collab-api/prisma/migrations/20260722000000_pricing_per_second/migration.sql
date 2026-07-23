-- 扩展 PricingUnit 枚举：新增 PER_SECOND（视频生成按秒计费）。
-- PostgreSQL 的 ALTER TYPE ... ADD VALUE 不能在事务块内执行，故逐条独立语句。
-- IF NOT EXISTS 保证幂等（重复应用不报错）。
ALTER TYPE "PricingUnit" ADD VALUE IF NOT EXISTS 'PER_SECOND';
