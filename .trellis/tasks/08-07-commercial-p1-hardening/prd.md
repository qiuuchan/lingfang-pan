# 商业就绪 P1 加固：核验 + 测试补全

## 背景

2026-08-07 商业发行就绪度评估（`D:\lf-pan\lingfang-commercial-readiness-2026-08-07.html`）列出两项 P1 产品侧缺口：

1. `admin-users.service.ts:71` 空密码回退 `ChangeMe123!`
2. 更新链路 minisign 验签未闭环（后端无签名下发）

核查发现并行会话已实现两项修复（未提交）：

- `admin-users.service.ts` 已改为拒绝空密码 + 最少 8 位
- 新增 `release-signing.ts`（上传时用 `LINGFANG_RELEASE_SIGNING_KEY` 对安装包 minisign 签名，写入 `ReleaseAsset.signature`，随 `/api/releases/latest` 下发；fail-closed）
- `update.rs` / `updater.ts` 已消费 `signature` 字段（配置 `LINGFANG_UPDATER_PUBKEY` 后强制验签）

本任务不重复实现，做核验与补全。

## 范围

1. **契约核验**（只读）：后端签名格式（release-signing.ts）与桌面 minisign-verify 0.2.5 crate 的 decode/verify 语义逐字段比对。
2. **修复陈旧注释**：`schema.prisma:1273` 仍称 signature 列"已废弃，不再写入/使用"，与 1285 行新语义冲突。
3. **补测试**：
   - 新增 `admin-users.service.spec.ts`：空密码拒绝、短密码拒绝、正常创建路径。
   - `release.service.spec.ts` 补签名集成用例：配置密钥→signature 写入；签名失败→500 fail-closed。
4. **验证**：运行受影响模块测试 + typecheck。

## 验收标准

- [x] 签名格式兼容性核验结论记录（research/signature-format-compat.md：完全兼容 ✅）
- [x] schema.prisma 注释与新语义一致（1273 行陈旧"已废弃"注释已订正）
- [x] `admin-users.service.spec.ts` 存在且通过（7 用例：403/空密码/undefined/短密码/哈希落库/RBAC 双写/改密路径）
- [x] `release.service.spec.ts` 覆盖签名开关三条路径且通过（未配置恒空/配置即签名/非法密钥 fail-closed）
- [x] collab-api typecheck 通过；全量单测 1015 passed / 0 failed
- [x] spec 更新：`lingfang-desktop/backend/updater-integration.md` 订正过时表述（minisign 验签回归 + 签名格式契约 + SSRF 守卫）

## 明确不做

- 不改 release-signing.ts / update.rs 实现（已核验正确）
- 不提交 commit（脏文件含大量他人未提交改动，提交由用户统一处理）
- 法务件 / 证书 / 商户号 / ICP 备案（用户负责）
