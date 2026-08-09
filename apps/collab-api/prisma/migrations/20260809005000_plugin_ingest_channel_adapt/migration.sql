-- 扩展 PluginIngestChannel 枚举：新增 ADAPT。
-- ADAPT 表示上传前已在客户端跑完「灵坊适配检验改造」流水线（含运行时确证），
-- 与 DESKTOP（普通桌面上传）区分，便于审核侧按渠道分流与统计。
-- 注意：PostgreSQL 的 ALTER TYPE ... ADD VALUE 不能在事务块（BEGIN/COMMIT）内执行，
-- 故本迁移单独成文件、逐条独立语句；IF NOT EXISTS 保证幂等。
ALTER TYPE "PluginIngestChannel" ADD VALUE IF NOT EXISTS 'ADAPT';
