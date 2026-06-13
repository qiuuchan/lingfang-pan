-- 扩展 PluginRuntimeType 枚举：新增 NODEJS / PYTHON（见 R3）。
-- nodejs/python 为脚本型运行时，上传云端仅做源码托管，预览执行由桌面壳本地完成。
-- 注意：PostgreSQL 的 ALTER TYPE ... ADD VALUE 不能在事务块（BEGIN/COMMIT）内执行，
-- 故本迁移为逐条独立语句，prisma migrate deploy 按语句顺序应用。
-- IF NOT EXISTS 保证幂等（重复应用不报错）。
ALTER TYPE "PluginRuntimeType" ADD VALUE IF NOT EXISTS 'NODEJS';
ALTER TYPE "PluginRuntimeType" ADD VALUE IF NOT EXISTS 'PYTHON';
