-- 自制 Windows 安装/更新/卸载器：ReleaseAsset 增加 sha256 列。
-- 上传安装包时后端自动计算 SHA-256 十六进制摘要，自制更新器下载后比对校验完整性（替代旧 Tauri minisign 签名）。
-- 旧 signature 列保留（已废弃，不再写入），避免删列的 migration 风险。
-- 加列带默认值 ''，对存量行安全（无需 backfill）。
ALTER TABLE "ReleaseAsset" ADD COLUMN "sha256" TEXT NOT NULL DEFAULT '';
